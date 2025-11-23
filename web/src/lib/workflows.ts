export function buildTasksFromInput(raw: string): Array<{ id: string; title: string; instructions: string }> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      id: `task-${Date.now()}-${index}`,
      title: `Task ${index + 1}`,
      instructions: line
    }))
}
