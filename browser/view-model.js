export function productJourneyFlags({ status = {}, hasTarget = false, hasEvidence = false } = {}) {
  return [
    true,
    hasTarget,
    status.explored === true,
    status.reviewComplete === true,
    // A committed or promoted contract is not proof that it replayed on the
    // current revision. Only current validation evidence completes this step.
    status.validated === true,
    hasEvidence,
  ];
}
