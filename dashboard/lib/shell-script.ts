// On Windows, .sh scripts must be run via bash (e.g. Git Bash).
// Return the correct [command, args] pair for spawning a shell script.
export function scriptCmd(scriptPath: string, args: string[]): [string, string[]] {
  if (process.platform === "win32") {
    return ["bash", [scriptPath, ...args]];
  }
  return [scriptPath, args];
}
