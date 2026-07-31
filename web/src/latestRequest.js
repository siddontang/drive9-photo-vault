export function createLatestRequestGate() {
  let generation = 0;

  return {
    begin() {
      const requestGeneration = ++generation;
      return {
        isCurrent() {
          return requestGeneration === generation;
        },
      };
    },
    invalidate() {
      generation++;
    },
  };
}
