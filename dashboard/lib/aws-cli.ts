const COMMON_AWS_CLI_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export function awsCliCommand(): string {
  return process.env.AWS_CLI_PATH?.trim() || "aws";
}

export function withAwsCliPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const existingPath = env.PATH || process.env.PATH || "";
  const parts = existingPath.split(":").filter(Boolean);
  const pathEntries = [
    ...parts,
    ...COMMON_AWS_CLI_PATH_ENTRIES.filter((entry) => !parts.includes(entry)),
  ];

  return {
    ...env,
    PATH: pathEntries.join(":"),
  };
}
