import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { assertWorkingDirectory, recordWorkingDirectory } from "@/lib/working-directories";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const CANCELLED = "__SATURN_CANCELLED__";
const ERROR_PREFIX = "__SATURN_ERROR__:";

function pickerScript(): string {
  return `
on run argv
  set promptText to "Choose working directory"
  set defaultPath to ""
  if (count of argv) > 0 then set defaultPath to item 1 of argv

  try
    activate
    delay 0.2

    if defaultPath is not "" then
      try
        set defaultFolder to POSIX file defaultPath as alias
        set chosenFolder to choose folder with prompt promptText default location defaultFolder
      on error errMsg number errNum
        if errNum is -128 then error number -128
        set chosenFolder to choose folder with prompt promptText
      end try
    else
      set chosenFolder to choose folder with prompt promptText
    end if

    set pickedPath to POSIX path of chosenFolder
    return pickedPath
  on error errMsg number errNum
    if errNum is -128 then
      return "${CANCELLED}"
    else
      return "${ERROR_PREFIX}" & errNum & ": " & errMsg
    end if
  end try
end run
`;
}

async function runPickerApp(defaultDir: string): Promise<string | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-picker-"));
  const scriptPath = path.join(tempDir, "picker.applescript");

  try {
    await fs.writeFile(scriptPath, pickerScript(), "utf8");

    const args = [scriptPath];
    if (defaultDir) args.push(defaultDir);
    const { stdout } = await execFileAsync("osascript", args, {
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });

    const result = stdout.trim();
    if (!result || result === CANCELLED) return null;
    if (result.startsWith(ERROR_PREFIX)) {
      throw new Error(result.slice(ERROR_PREFIX.length));
    }
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { dir?: unknown } | null;
  let defaultDir = "";

  if (body && typeof body.dir === "string" && body.dir.trim()) {
    defaultDir = await assertWorkingDirectory(body.dir).catch(() => "");
  }

  try {
    const picked = await runPickerApp(defaultDir);
    if (!picked) return NextResponse.json({ cancelled: true });

    const entry = await recordWorkingDirectory(picked);
    return NextResponse.json({ dir: entry.path, recentDirs: [entry.path] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "folder picker failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
