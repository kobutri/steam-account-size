export function formatBytes(numBytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = numBytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`
}
