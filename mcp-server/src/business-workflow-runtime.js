// Reusable orchestration over existing execution adapters, with no new assertion engine.
export async function runBusinessWorkflow({ plan, runId, preflight, runFlow, runCapability, onProgress = async () => {} }) {
  if (!plan?.ready || !/^[a-zA-Z0-9_-]{8,120}$/.test(runId)) throw new Error("A ready workflow plan and unique run ID are required");
  // Validate all artifacts/accounts before the first external mutation.
  await preflight(plan);
  const steps = [];
  let failed = false;
  let started = false;
  const deadline = Date.now() + 15 * 60 * 1000;
  const execute = async step => {
    let result;
    try {
      await onProgress({ phase:step.phase,text:step.title });
      if (step.kind === "flow") {
        const remaining = Math.floor((deadline - Date.now()) / 1000);
        if (remaining < 30) throw new Error("Workflow time budget exhausted");
        result = await runFlow(step,runId,Math.min(120,remaining));
      } else if (step.kind === "capability") {
        if (step.phase !== "cleanup" && Date.now() >= deadline) throw new Error("Workflow time budget exhausted");
        result = await runCapability(step,runId);
      } else throw new Error("This step has no supported execution adapter");
      const ok = step.kind === "flow" ? result.passed === true
        : result.status === "observed" && (step.phase !== "verify" || (result.assertions?.length > 0 && result.assertions.every(assertion => assertion.matched === true)));
      const inconclusive=step.kind === "flow" && (result.timedOut === true || ![0,1].includes(result.exitCode));
      return { id:step.id,title:step.title,phase:step.phase,status:inconclusive ? "inconclusive" : ok ? (["prepare","cleanup"].includes(step.phase) ? "acknowledged" : "observed") : "failed",result };
    } catch(error) { return {id:step.id,title:step.title,phase:step.phase,status:"inconclusive",message:error.message || "Execution failed"}; }
  };
  try {
    for (const step of plan.steps.filter(step => step.phase !== "cleanup")) {
      if (failed) {steps.push({id:step.id,title:step.title,phase:step.phase,status:"not-run"});continue;}
      started = true;
      const result = await execute(step);
      steps.push(result);
      failed = !["observed","acknowledged"].includes(result.status);
    }
  } finally {
    // A setup request can mutate before failing. Always attempt the reviewed cleanup.
    for (const step of plan.steps.filter(step => step.phase === "cleanup")) {
      steps.push(started ? await execute(step) : {id:step.id,title:step.title,phase:step.phase,status:"not-run"});
    }
  }
  const status = steps.some(step => step.status === "inconclusive") ? "inconclusive"
    : steps.some(step => step.status === "failed") ? "failed"
    : steps.some(step => step.status === "not-run") ? "inconclusive" : "observed";
  return {kind:"tapp-business-workflow-run",workflowId:plan.workflowId,revision:plan.revision,bindingFingerprint:plan.bindingFingerprint,
    runId,status,steps,scope:plan.scope,completedAt:new Date().toISOString()};
}
