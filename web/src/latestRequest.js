export function createLatestRequestGate(initialQuery = '', initialTag = '') {
  let generation = 0;
  let search = { q: initialQuery, tag: initialTag };

  return {
    begin() {
      const requestGeneration = ++generation;
      const requestSearch = search;
      return {
        search: requestSearch,
        isCurrent() {
          return requestGeneration === generation;
        },
      };
    },
    setSearch(q, tag) {
      if (q === search.q && tag === search.tag) return;
      search = { q, tag };
      generation++;
    },
    invalidate() {
      generation++;
    },
  };
}
