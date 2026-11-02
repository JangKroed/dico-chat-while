// Keep the user's ordering and selections outside the current filter. A bulk
// operation either adds the entire eligible set or leaves a capped list alone.
export function selectEligibleIds(selected:readonly string[],eligible:readonly string[],limit=Infinity):string[] {
  const next=[...new Set([...selected,...eligible])]
  return next.length<=limit?next:[...selected]
}
