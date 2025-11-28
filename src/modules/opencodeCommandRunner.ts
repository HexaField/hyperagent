export type OpencodeCommandOptions = {
  cwd?: string
}

export type OpencodeCommandResult = {
  stdout: string
  stderr: string
}

export type OpencodeCommandRunner = (
  args: string[],
  options?: OpencodeCommandOptions
) => Promise<OpencodeCommandResult | void>

export type CodingAgentCommandOptions = OpencodeCommandOptions
export type CodingAgentCommandResult = OpencodeCommandResult
export type CodingAgentCommandRunner = OpencodeCommandRunner
