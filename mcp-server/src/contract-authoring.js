// Runtime half of the TypeScript authoring API. TypeScript supplies the
// repository-side type checking; this function keeps the authored value plain,
// serializable, and deterministic for Tapp's compiler.
export function defineContract(contract) {
  return {
    ...contract,
    kind: "release-contract",
    version: contract?.version ?? 1,
  };
}
