// Execution contract regression.
//
// server/execution-contract.ts is the single owner of attempt lifecycle rules,
// so this suite drives it directly: the table's structural invariants, every
// typed failure and its precedence, compare-and-set races and idempotent
// replay, reconciliation origins, and a property check that no sequence of
// requests moves an attempt along an edge the table does not declare. The
// module is pure, so no database, process, or Git fixture is involved.
import fc from "fast-check";
import {
  EXECUTION_CONTRACT_VERSION,
  ExecutionContractError,
  allowedExecutionEvents,
  executionActorKinds,
  executionContractErrorCodes,
  executionEvents,
  executionStates,
  executionTransitions,
  isTerminalExecutionState,
  planExecutionTransition,
  renderExecutionContractMarkdown,
  resumableExecutionStates,
} from "../server/execution-contract.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const AT = "2026-01-01T00:00:00.000Z";
const operator = { kind: "operator", id: "operator-1" };
const reconciler = { kind: "reconciler", id: "startup" };
const owningAgent = { kind: "agent", id: "session-a" };

function snapshot(state, overrides = {}) {
  return {
    state,
    revision: 0,
    session_id: "session-a",
    reconciliation_origin: null,
    last_idempotency_key: null,
    last_event: null,
    ...overrides,
  };
}

let keyCounter = 0;
function request(event, overrides = {}) {
  keyCounter += 1;
  return {
    event,
    expected_revision: 0,
    idempotency_key: `key-${keyCounter}`,
    actor: { kind: "control_plane", id: "hub" },
    at: AT,
    ...overrides,
  };
}

const observedCodes = new Set();
function expectCode(run, code, message) {
  try {
    run();
  } catch (error) {
    assert(error instanceof ExecutionContractError, `${message}: expected ExecutionContractError, got ${error}`);
    assert(error.code === code, `${message}: expected ${code}, got ${error.code} (${error.message})`);
    observedCodes.add(error.code);
    return error;
  }
  throw new Error(`${message}: expected ${code}, but the transition applied`);
}

function apply(current, event, overrides = {}) {
  const plan = planExecutionTransition(current, request(event, { expected_revision: current.revision, ...overrides }));
  assert(plan.outcome === "applied", `${event} from ${current.state} should apply, got ${plan.outcome}`);
  return plan;
}

function targetsOf(rule) {
  return rule.to === "origin" ? resumableExecutionStates : [rule.to];
}

function ruleFor(event, state) {
  return executionTransitions.find((rule) => rule.event === event && rule.from.includes(state));
}

// --- table invariants ---------------------------------------------------------

{
  const pairs = new Set();
  for (const rule of executionTransitions) {
    assert(executionEvents.includes(rule.event), `unknown event in the table: ${rule.event}`);
    assert(rule.to === "origin" || executionStates.includes(rule.to), `${rule.event} targets unknown state ${rule.to}`);
    assert((rule.to === "origin") === (rule.requires === "origin"), `${rule.event}: only a transition to the recorded origin may require it`);
    assert(rule.actors.length > 0 && rule.actors.every((actor) => executionActorKinds.includes(actor)), `${rule.event} has an empty or unknown actor list`);
    assert(!rule.summary.includes("|"), `${rule.event} summary would break the generated table`);
    // Leaving the happy path always records a typed reason; nothing else takes one.
    const offPath = ["failed", "canceled", "stale"].includes(rule.to);
    if (offPath) {
      assert(rule.reasons?.length > 0 && new Set(rule.reasons).size === rule.reasons.length, `${rule.event} to ${rule.to} must list distinct reason codes`);
    } else {
      assert(rule.reasons === undefined, `${rule.event} to ${rule.to} stays on the happy path and must not take reason codes`);
    }
    for (const from of rule.from) {
      assert(executionStates.includes(from), `${rule.event} starts from unknown state ${from}`);
      assert(!isTerminalExecutionState(from), `terminal state ${from} has an outgoing ${rule.event}`);
      const pair = `${rule.event}:${from}`;
      assert(!pairs.has(pair), `ambiguous table: ${pair} is declared twice`);
      pairs.add(pair);
    }
  }
  for (const event of executionEvents) {
    assert(executionTransitions.some((rule) => rule.event === event), `event ${event} has no transition`);
  }
  for (const state of executionStates) {
    const outgoing = allowedExecutionEvents(state);
    if (isTerminalExecutionState(state)) assert(outgoing.length === 0, `terminal state ${state} must be absorbing`);
    else assert(outgoing.length > 0, `non-terminal state ${state} must have a way out`);
  }

  // Every state is reachable from provisioning, and no state is a trap: each
  // one can still reach a terminal state.
  const reach = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const state = queue.shift();
      for (const rule of executionTransitions.filter((candidate) => candidate.from.includes(state))) {
        for (const target of targetsOf(rule)) {
          if (!seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
        }
      }
    }
    return seen;
  };
  const fromProvisioning = reach("provisioning");
  for (const state of executionStates) {
    assert(fromProvisioning.has(state), `${state} is unreachable from provisioning`);
    assert([...reach(state)].some(isTerminalExecutionState), `${state} cannot reach a terminal state`);
  }

  // The minimum lifecycle the ticket requires is a chain of single edges.
  const chain = ["provisioning", "running", "verifying", "reviewable", "accepted"];
  for (let index = 0; index < chain.length - 1; index += 1) {
    assert(
      executionTransitions.some((rule) => rule.from.includes(chain[index]) && rule.to === chain[index + 1]),
      `missing lifecycle edge ${chain[index]} -> ${chain[index + 1]}`,
    );
  }
  const intoAccepted = executionTransitions.filter((rule) => rule.to === "accepted");
  assert(intoAccepted.length === 1 && intoAccepted[0].requires === "policy", "acceptance must have exactly one entry, and it must require a policy");
}

// --- happy path and provenance -------------------------------------------------

{
  let current = snapshot("provisioning");
  const records = [];
  for (const [event, overrides] of [
    ["launch", {}],
    ["complete_run", {}],
    ["pass_verification", {}],
    ["accept", { actor: operator, policy: "operator-approval", note: "Reviewed the diff and test evidence." }],
  ]) {
    const plan = apply(current, event, overrides);
    records.push(plan.record);
    current = plan.snapshot;
  }
  assert(current.state === "accepted" && current.revision === 4, `happy path ended at ${current.state}@${current.revision}`);
  assert(
    records.map((record) => `${record.from}>${record.to}`).join(",") === "provisioning>running,running>verifying,verifying>reviewable,reviewable>accepted",
    `unexpected transition history ${JSON.stringify(records.map((record) => [record.from, record.to]))}`,
  );
  assert(records.every((record, index) => record.contract_version === EXECUTION_CONTRACT_VERSION && record.revision === index + 1 && record.at === AT), "records must carry the contract version, a +1 revision, and the timestamp");
  const acceptance = records[3];
  assert(acceptance.actor.kind === "operator" && acceptance.actor.id === "operator-1", "acceptance must record the operator who approved it");
  assert(acceptance.policy === "operator-approval" && acceptance.note === "Reviewed the diff and test evidence.", "acceptance must record its policy and note");
  assert(current.session_id === "session-a", "transitions must preserve the owning session");
}

// --- verification never equals acceptance -------------------------------------

{
  assert(!isTerminalExecutionState("reviewable"), "reviewable must not be terminal");
  expectCode(() => planExecutionTransition(snapshot("reviewable"), request("accept")), "policy_required", "control-plane acceptance without a policy");
  expectCode(() => planExecutionTransition(snapshot("reviewable"), request("accept", { actor: owningAgent, policy: "self" })), "unauthorized_actor", "an agent accepting its own work");
  expectCode(() => planExecutionTransition(snapshot("verifying"), request("accept", { actor: operator, policy: "operator-approval" })), "invalid_transition", "acceptance before verification passes");
  const autoAccepted = planExecutionTransition(snapshot("reviewable"), request("accept", { policy: "local-auto" }));
  assert(autoAccepted.outcome === "applied" && autoAccepted.snapshot.state === "accepted", "an explicitly named control-plane policy may accept");
}

// --- terminal states are absorbing ---------------------------------------------

for (const state of ["accepted", "failed", "canceled"]) {
  for (const event of executionEvents) {
    expectCode(() => planExecutionTransition(snapshot(state), request(event, { actor: operator, policy: "operator-approval" })), "terminal_state", `${event} from terminal ${state}`);
  }
}

// --- invalid transitions, authority, and reasons --------------------------------

{
  const error = expectCode(() => planExecutionTransition(snapshot("provisioning"), request("pass_verification")), "invalid_transition", "verification before the harness runs");
  assert(JSON.stringify(error.details.allowed) === JSON.stringify(allowedExecutionEvents("provisioning")), "invalid_transition must list the allowed events");

  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("launch", { actor: owningAgent })), "unauthorized_actor", "an agent launching its own harness");
  expectCode(() => planExecutionTransition(snapshot("running"), request("cancel", { actor: { kind: "agent", id: "session-b" }, reason: "agent_requested" })), "unauthorized_actor", "an agent canceling another session's attempt");
  expectCode(() => planExecutionTransition(snapshot("running"), request("cancel", { actor: reconciler, reason: "superseded" })), "unauthorized_actor", "the reconciler canceling live work");
  expectCode(() => planExecutionTransition(snapshot("stale"), request("cancel", { reason: "operator_requested" })), "unauthorized_actor", "the control plane canceling quarantined work");
  const ownCancel = planExecutionTransition(snapshot("running"), request("cancel", { actor: owningAgent, reason: "agent_requested" }));
  assert(ownCancel.outcome === "applied" && ownCancel.snapshot.state === "canceled", "the owning agent may cancel its attempt");
  const operatorCancel = planExecutionTransition(snapshot("stale"), request("cancel", { actor: operator, reason: "operator_requested" }));
  assert(operatorCancel.outcome === "applied" && operatorCancel.record.reason === "operator_requested", "an operator may cancel quarantined work and the reason is recorded");

  expectCode(() => planExecutionTransition(snapshot("running"), request("fail")), "invalid_reason", "fail without a reason code");
  expectCode(() => planExecutionTransition(snapshot("running"), request("fail", { reason: "it broke" })), "invalid_reason", "fail with prose instead of a code");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("launch", { reason: "harness_failed" })), "invalid_reason", "a reason code on a transition that takes none");
  expectCode(() => planExecutionTransition(snapshot("verifying"), request("fail_verification", { reason: "review_rejected" })), "invalid_reason", "another event's reason code");

  // Reason codes belong to the matched rule, not the event: the same event from
  // a different state accepts a different set.
  const liveFail = expectCode(() => planExecutionTransition(snapshot("running"), request("fail", { actor: owningAgent, reason: "reconciliation_failed" })), "invalid_reason", "live work failing with a reconciliation code");
  assert(JSON.stringify(liveFail.details.allowed) === JSON.stringify(ruleFor("fail", "running").reasons), "invalid_reason must list the matched rule's codes");
  expectCode(() => planExecutionTransition(snapshot("stale"), request("fail", { actor: reconciler, reason: "harness_failed" })), "invalid_reason", "quarantined work failing with a live-run code");
  expectCode(() => planExecutionTransition(snapshot("reconciling"), request("cancel", { actor: operator, reason: "agent_requested" })), "invalid_reason", "recovering work canceled with an agent code");
}

// --- compare-and-set and idempotency ---------------------------------------------

{
  expectCode(() => planExecutionTransition(snapshot("running", { revision: 3 }), request("complete_run", { expected_revision: 2 })), "revision_conflict", "a stale expected revision");
  expectCode(() => planExecutionTransition(snapshot("running", { revision: 3 }), request("accept", { expected_revision: 2 })), "revision_conflict", "revision conflict takes precedence over an invalid transition");

  // Two launches racing on the same revision with different keys: exactly one applies.
  const provisioning = snapshot("provisioning");
  const winner = planExecutionTransition(provisioning, request("launch"));
  assert(winner.outcome === "applied" && winner.snapshot.revision === 1, "the first launch must apply");
  expectCode(() => planExecutionTransition(winner.snapshot, request("launch")), "revision_conflict", "a second launch on the consumed revision");

  // A lost response: the same request resent after it applied is a replay, even
  // though the attempt is now terminal.
  const cancel = request("cancel", { expected_revision: 1, actor: operator, reason: "operator_requested" });
  const canceled = planExecutionTransition(snapshot("running", { revision: 1 }), cancel);
  assert(canceled.outcome === "applied" && canceled.snapshot.state === "canceled" && canceled.snapshot.revision === 2, "cancel must apply");
  const replay = planExecutionTransition(canceled.snapshot, cancel);
  assert(replay.outcome === "replayed" && replay.snapshot === canceled.snapshot, "resending the last request must return the attempt unchanged");
  expectCode(() => planExecutionTransition(canceled.snapshot, { ...cancel, event: "fail", reason: "abandoned" }), "idempotency_conflict", "reusing a key for a different event");
}

// --- reconciliation origins --------------------------------------------------------

{
  const began = apply(snapshot("verifying", { revision: 2 }), "begin_reconciliation", { actor: reconciler });
  assert(began.snapshot.state === "reconciling" && began.snapshot.reconciliation_origin === "verifying", "reconciliation must record its origin");
  const resumed = apply(began.snapshot, "resume", { actor: reconciler });
  assert(resumed.snapshot.state === "verifying" && resumed.snapshot.reconciliation_origin === null, "resume must return to the origin and clear it");

  const quarantined = apply(began.snapshot, "mark_stale", { actor: reconciler, reason: "worktree_missing" });
  assert(quarantined.snapshot.state === "stale" && quarantined.snapshot.reconciliation_origin === null, "reconciliation may quarantine instead of resuming");

  const staleRecovery = apply(snapshot("stale"), "begin_reconciliation", { actor: operator });
  expectCode(() => planExecutionTransition(staleRecovery.snapshot, request("resume", { expected_revision: staleRecovery.snapshot.revision, actor: operator })), "origin_not_resumable", "stale work resuming");
  expectCode(() => planExecutionTransition(snapshot("reconciling"), request("resume", { actor: reconciler })), "origin_not_resumable", "resume with no recorded origin");
  const abandoned = apply(staleRecovery.snapshot, "fail", { actor: reconciler, reason: "reconciliation_failed" });
  assert(abandoned.snapshot.state === "failed", "the reconciler may abandon quarantined work");
}

// --- request validation ---------------------------------------------------------------

{
  expectCode(() => planExecutionTransition(snapshot("paused"), request("launch")), "unknown_state", "a state outside the contract");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("teleport")), "unknown_event", "an event outside the contract");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("teleport", { idempotency_key: "  " })), "invalid_request", "invalid_request takes precedence over unknown_event");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("launch", { idempotency_key: "k".repeat(201) })), "invalid_request", "an oversized idempotency key");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("launch", { expected_revision: "0" })), "invalid_request", "a string revision");
  expectCode(() => planExecutionTransition(snapshot("provisioning", { revision: -1 }), request("launch")), "invalid_request", "a negative stored revision");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("launch", { actor: { kind: "root", id: "x" } })), "invalid_request", "an unknown actor kind");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("launch", { actor: { kind: "operator", id: " " } })), "invalid_request", "a blank actor id");
  expectCode(() => planExecutionTransition(snapshot("provisioning"), request("launch", { note: "n".repeat(2001) })), "invalid_request", "an oversized note");
}

// --- property: only declared edges ever apply --------------------------------------------

{
  const allReasons = [...new Set(executionTransitions.flatMap((rule) => rule.reasons ?? []))];
  const step = fc.record({
    event: fc.constantFrom(...executionEvents),
    actor: fc.constantFrom(...executionActorKinds).map((kind) => ({ kind, id: kind === "agent" ? "session-a" : `${kind}-1` })),
    reason: fc.option(fc.constantFrom(...allReasons), { nil: undefined }),
    policy: fc.option(fc.constantFrom("operator-approval", "local-auto"), { nil: undefined }),
  });
  fc.assert(
    fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
      let current = snapshot("provisioning");
      steps.forEach((item, index) => {
        let plan;
        try {
          plan = planExecutionTransition(current, { ...item, expected_revision: current.revision, idempotency_key: `property-${index}`, at: AT });
        } catch (error) {
          if (!(error instanceof ExecutionContractError)) throw error;
          assert(executionContractErrorCodes.includes(error.code), `untyped failure code ${error.code}`);
          if (isTerminalExecutionState(current.state)) assert(error.code === "terminal_state", `terminal ${current.state} failed with ${error.code}`);
          return;
        }
        assert(plan.outcome === "applied", "a fresh idempotency key must never replay");
        const rule = ruleFor(item.event, current.state);
        assert(rule, `applied undeclared edge ${current.state} --${item.event}-->`);
        assert(rule.actors.includes(item.actor.kind), `${item.actor.kind} performed ${item.event} without authority`);
        assert(
          rule.reasons ? rule.reasons.includes(item.reason) : item.reason === undefined,
          `${item.event} from ${current.state} applied with reason ${item.reason}`,
        );
        const expected = rule.to === "origin" ? current.reconciliation_origin : rule.to;
        assert(plan.snapshot.state === expected, `${item.event} from ${current.state} reached ${plan.snapshot.state}, expected ${expected}`);
        assert(plan.snapshot.revision === current.revision + 1, "each applied transition must increment the revision by one");
        assert(plan.record.from === current.state && plan.record.to === plan.snapshot.state, "the record must match the move");
        current = plan.snapshot;
      });
    }),
    { numRuns: 500 },
  );
}

// --- coverage of the typed failure surface and the rendered contract -----------------------

for (const code of executionContractErrorCodes) {
  assert(observedCodes.has(code), `no test exercised typed failure ${code}`);
}
{
  const markdown = renderExecutionContractMarkdown();
  assert(markdown.includes(`\`${EXECUTION_CONTRACT_VERSION}\``), "rendered contract must state its version");
  for (const name of [...executionStates, ...executionEvents, ...executionContractErrorCodes]) {
    assert(markdown.includes(`\`${name}\``), `rendered contract is missing ${name}`);
  }
}

console.log("Execution contract regression passed");
