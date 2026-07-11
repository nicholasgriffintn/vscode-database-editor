export function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
