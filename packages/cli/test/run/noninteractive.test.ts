import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  OpenCode,
  type EventSubscribeOutput,
  type ExperimentalJobListOutput,
  type SessionMessageAssistantTool,
  type SessionMessageInfo,
} from "@opencode/client/promise"
import { runNonInteractivePrompt } from "../../src/run/noninteractive"

type V2Event = EventSubscribeOutput
type FormInfo = Extract<V2Event, { type: "form.created" }>["data"]["form"]
const location = { directory: "/work tree", workspaceID: "wrk_1" }

function ok<T>(data: T) {
  return Promise.resolve(data)
}

function form(id: string, sessionID: string): FormInfo {
  return {
    id,
    sessionID,
    title: "Input requested",
    fields: [{ key: "authorization", type: "external", url: "https://example.com/form" }],
  }
}

function formCreated(info: FormInfo, eventLocation = location): V2Event {
  return { id: `evt_${info.id}`, created: 0, type: "form.created", location: eventLocation, data: { form: info } }
}

function prompted(inboxID: string): V2Event {
  return {
    id: "evt_prompted",
    created: 0,
    type: "session.inbox.delivered",
    durable: { aggregateID: "ses_1", seq: 0, version: 1 },
    data: { sessionID: "ses_1", inboxID },
  }
}

function settled(outcome: "success" | "interrupted" = "success"): V2Event {
  if (outcome === "interrupted")
    return {
      id: "evt_interrupted",
      created: 0,
      type: "session.execution.interrupted",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", reason: "user" },
    }
  return {
    id: "evt_succeeded",
    created: 0,
    type: "session.execution.succeeded",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1" },
  }
}

function stepStarted(): V2Event {
  return {
    id: "evt_step_started",
    created: 1,
    type: "session.step.started",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: {
      started: 1,
      sessionID: "ses_1",
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
    },
  }
}

function stepFailed(message: string): V2Event {
  return {
    id: "evt_step_failed",
    created: 2,
    type: "session.step.failed",
    durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_assistant",
      error: { type: "provider.transport", message },
    },
  }
}

function executionFailed(message: string): V2Event {
  return {
    id: "evt_execution_failed",
    created: 3,
    type: "session.execution.failed",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 },
    data: {
      sessionID: "ses_1",
      error: { type: "provider.transport", message },
    },
  }
}

type Outcome = "succeeded" | "failed" | "interrupted"

// Idle markers take their ID from the terminal event that projects them.
function idleMessage(
  outcome: Outcome = "succeeded",
  id = `msg_${outcome === "failed" ? "execution_failed" : outcome}`,
) {
  return {
    id,
    type: "idle",
    outcome,
    ...(outcome === "failed" ? { error: { type: "provider.transport" as const, message: "Execution failed" } } : {}),
    time: { created: 5 },
  } satisfies SessionMessageInfo
}

// A step that failed and was retried, followed by the step that recovered.
function recoveredMessages(outcome: Outcome) {
  return (messageID: string): SessionMessageInfo[] => [
    idleMessage(outcome),
    {
      id: "msg_recovered",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      content: [{ type: "text", text: "Recovered answer" }],
      finish: "stop",
      time: { created: 3, completed: 4 },
    },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      content: [],
      finish: "error",
      error: { type: "provider.transport", message: "Recovered transport error" },
      time: { created: 2, completed: 3 },
    },
    { id: messageID, type: "user", text: "hello", time: { created: 1 } },
  ]
}

function retryScheduled(): V2Event {
  return {
    id: "evt_retry",
    created: 3,
    type: "session.retry.scheduled",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_assistant",
      attempt: 1,
      at: 2003,
      error: { type: "provider.transport", message: "Recovered transport error" },
    },
  }
}

function jsonLines(stdout: string) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function failedTool(inboxID: string): V2Event[] {
  return [
    prompted(inboxID),
    {
      id: "evt_failed_tool_input",
      created: 1,
      type: "session.tool.input.started",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        name: "shell",
      },
    },
    {
      id: "evt_failed_tool_called",
      created: 2,
      type: "session.tool.called",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        input: { command: "printf partial && false" },
        executed: true,
      },
    },
    {
      id: "evt_failed_tool_progress",
      created: 3,
      type: "session.tool.progress",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        metadata: { checkpoint: 1 },
      },
    },
    {
      id: "evt_failed_tool_terminal",
      created: 4,
      type: "session.tool.failed",
      durable: { aggregateID: "ses_1", seq: 4, version: 2 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        id: "call_failed_tool",
        error: { type: "unknown", message: "tool failed" },
        metadata: { checkpoint: 1 },
        content: [{ type: "text", text: "partial output" }],
        executed: true,
      },
    },
    settled(),
  ]
}

function successfulGrep(inboxID: string): V2Event[] {
  const text = "Found 2 matches\n/src/a.ts:\n  Line 1: needle\n/src/b.ts:\n  Line 2: needle"
  return [
    prompted(inboxID),
    {
      id: "evt_grep_input",
      created: 1,
      type: "session.tool.input.started",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_grep",
        id: "call_grep",
        name: "grep",
      },
    },
    {
      id: "evt_grep_called",
      created: 2,
      type: "session.tool.called",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_grep",
        id: "call_grep",
        input: { pattern: "needle" },
        executed: true,
      },
    },
    {
      id: "evt_grep_success",
      created: 3,
      type: "session.tool.success",
      durable: { aggregateID: "ses_1", seq: 3, version: 2 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_grep",
        id: "call_grep",
        metadata: { matches: 2 },
        content: [{ type: "text", text }],
        executed: false,
      },
    },
    settled(),
  ]
}

// Runs one non-interactive prompt against a mocked SDK. `turn` produces the
// live events the prompt admission triggers, keyed by the generated message ID.
async function run(input: {
  turn: (inboxID: string) => V2Event[]
  pendingForms?: FormInfo[]
  attached?: boolean
  format?: "default" | "json"
  compatibility?: "v1"
  cancel?: (input: { sessionID: string; formID: string }) => Promise<void>
  renderTool?: (part: SessionMessageAssistantTool) => Promise<void>
  renderToolError?: (part: SessionMessageAssistantTool) => Promise<void>
  messages?: (inboxID: string) => SessionMessageInfo[]
  wait?: () => Promise<void>
  jobs?: () => ExperimentalJobListOutput
  inbox?: (sessionID: string) => unknown[]
  terminalDelay?: number
}) {
  const sdk = OpenCode.make({ baseUrl: "https://opencode.test" })
  const values: V2Event[] = [{ id: "evt_connected", type: "server.connected", data: {} }]
  let wake: (() => void) | undefined
  const wait = Promise.withResolvers<void>()
  const stream = (async function* (): AsyncGenerator<V2Event, void, unknown> {
    while (true) {
      const value = values.shift()
      if (!value) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      if (value.type.startsWith("session.execution.")) {
        if (input.terminalDelay) await Bun.sleep(input.terminalDelay)
        setTimeout(wait.resolve, 0)
      }
      yield value
    }
  })()
  spyOn(sdk.event, "subscribe").mockImplementation((() => stream) as typeof sdk.event.subscribe)
  spyOn(sdk.permission, "list").mockImplementation(() => ok([]) as never)
  spyOn(sdk.permission, "reply").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.session.form, "list").mockImplementation(
    (request) => ok(input.pendingForms?.filter((item) => item.sessionID === request.sessionID) ?? []) as never,
  )
  spyOn(sdk.form, "list").mockImplementation(
    () =>
      ok({
        location: { ...location, project: { id: "proj_1", directory: location.directory } },
        data: input.pendingForms?.filter((item) => item.sessionID === "global") ?? [],
      }) as never,
  )
  spyOn(sdk.session.form, "cancel").mockImplementation((request) => (input.cancel?.(request) ?? ok(undefined)) as never)
  let promptID = "msg_prompt"
  spyOn(sdk.experimental.session, "wait").mockImplementation(() => input.wait?.() ?? wait.promise)
  spyOn(sdk.experimental.job, "list").mockImplementation(() => ok(input.jobs?.() ?? []) as never)
  spyOn(sdk.session, "active").mockImplementation(() => ok({}) as never)
  spyOn(sdk.session.inbox, "list").mockImplementation(({ sessionID }) => ok(input.inbox?.(sessionID) ?? []) as never)
  spyOn(sdk.session, "get").mockImplementation(
    ({ sessionID }) => ok({ id: sessionID, parentID: sessionID === "ses_child" ? "ses_1" : undefined }) as never,
  )
  spyOn(sdk.message, "list").mockImplementation(() =>
    ok({
      data: input.messages?.(promptID) ?? [{ id: promptID, type: "user", text: "hello", time: { created: 1 } }],
      cursor: {},
    }),
  )
  spyOn(sdk.session, "prompt").mockImplementation((request) => {
    const messageID = request.id ?? "msg_prompt"
    promptID = messageID
    values.push(...input.turn(messageID))
    wake?.()
    wake = undefined
    return ok({ id: messageID, sessionID: "ses_1", time: { created: 1 } }) as never
  })
  await runNonInteractivePrompt({
    client: sdk,
    sessionID: "ses_1",
    location,
    message: "hello",
    files: [],
    thinking: false,
    format: input.format ?? "default",
    auto: false,
    attached: input.attached ?? false,
    compatibility: input.compatibility,
    renderTool: input.renderTool ?? (() => Promise.resolve()),
    renderToolError: input.renderToolError ?? (() => Promise.resolve()),
  })
  return sdk
}

async function capture(input: Parameters<typeof run>[0]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = process.exitCode
  const stdoutWrite = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  try {
    await run(input)
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode }
  } finally {
    process.exitCode = exitCode ?? 0
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }
}

afterEach(() => {
  mock.restore()
  process.exitCode = 0
})

function shellJob(id: string, command: string): ExperimentalJobListOutput[number] {
  return { kind: "shell", id, sessionID: "ses_1", status: "running", shellID: id, command, time: { started: 1 } }
}

const subagentJob: ExperimentalJobListOutput[number] = {
  kind: "subagent",
  id: "ses_child",
  sessionID: "ses_1",
  status: "running",
  childSessionID: "ses_child",
  agent: "explore",
  description: "scan repo",
  time: { started: 1 },
}

describe("runNonInteractivePrompt", () => {
  test("keeps formatted tool output and compact tool metadata in JSON", async () => {
    const output = await capture({ format: "json", turn: successfulGrep })
    const events = output.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_use",
      part: {
        tool: "grep",
        state: {
          status: "completed",
          output: expect.stringContaining("Found 2 matches"),
          metadata: {
            metadata: { matches: 2 },
            content: [{ type: "text", text: expect.stringContaining("/src/a.ts") }],
          },
        },
      },
    })
    expect(events[0].part.state.metadata.metadata).toEqual({ matches: 2 })
    expect(events[0].part.state.metadata.result).toBeUndefined()
  })

  test("uses session.wait then reconciles projected output without a terminal event", async () => {
    const idle = Promise.withResolvers<void>()
    let done = false
    const task = capture({
      format: "json",
      turn: (messageID) => [prompted(messageID)],
      wait: () => idle.promise,
      messages: (messageID) => [
        idleMessage(),
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test-model" },
          content: [{ type: "text", text: "projected answer" }],
          finish: "stop",
          time: { created: 2, completed: 3 },
        },
        { id: messageID, type: "user", text: "hello", time: { created: 1 } },
      ],
    }).then((output) => {
      done = true
      return output
    })

    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(done).toBe(false)
    idle.resolve()
    const output = await task
    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ type: "step_start", part: expect.objectContaining({ messageID: "msg_assistant" }) }),
      expect.objectContaining({ type: "text", part: expect.objectContaining({ text: "projected answer" }) }),
    ])
  })

  test("reports usage for a step that ends after the Session goes idle", async () => {
    const tokens = { input: 3, output: 5, reasoning: 7, cache: { read: 11, write: 13 } }
    const assistant = (messageID: string): SessionMessageInfo[] => [
      idleMessage(),
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "test-model" },
        content: [{ type: "text", text: "done" }],
        finish: "stop",
        cost: 0.25,
        tokens,
        time: { created: 2, completed: 3 },
      },
      { id: messageID, type: "user", text: "hello", time: { created: 1 } },
    ]
    const lines = async (turn: (messageID: string) => V2Event[]) =>
      (await capture({ format: "json", turn, messages: assistant, wait: () => Promise.resolve() })).stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))

    const missed = await lines((messageID) => [prompted(messageID), stepStarted()])
    expect(missed.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
    expect(missed[2].part).toMatchObject({ messageID: "msg_assistant", reason: "stop", cost: 0.25, tokens })

    const seen = await lines((messageID) => [
      prompted(messageID),
      stepStarted(),
      {
        id: "evt_step_ended",
        created: 2,
        type: "session.step.ended",
        durable: { aggregateID: "ses_1", seq: 2, version: 1 },
        data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", finish: "stop", cost: 0.25, tokens },
      },
      settled(),
    ])
    expect(seen.filter((event) => event.type === "step_finish")).toHaveLength(1)
  })

  test("reports an observed execution failure before prompt promotion", async () => {
    const output = await capture({
      format: "json",
      turn: () => [executionFailed("instructions unavailable")],
      messages: () => [],
    })

    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({
        type: "error",
        error: { type: "provider.transport", message: "instructions unavailable" },
      }),
    ])
    expect(output.exitCode).toBe(1)
  })

  test("waits for a terminal failure when idle wins before projection", async () => {
    for (const promotedBeforeFailure of [true, false]) {
      const output = await capture({
        format: "json",
        turn: (messageID) => [
          ...(promotedBeforeFailure ? [prompted(messageID)] : []),
          executionFailed("selection unavailable"),
        ],
        messages: (messageID) =>
          promotedBeforeFailure ? [{ id: messageID, type: "user", text: "hello", time: { created: 1 } }] : [],
        wait: () => Promise.resolve(),
        terminalDelay: 10,
      })

      expect(output.exitCode).toBe(1)
      expect(output.stdout).toContain("selection unavailable")
    }
  })

  test("a recovered step failure and its retry exit 0 and still wait for background work", async () => {
    const lists: ExperimentalJobListOutput[] = [[shellJob("sh_train", "python train.py")], []]
    const output = await capture({
      format: "json",
      jobs: () => lists.shift() ?? [],
      messages: recoveredMessages("succeeded"),
      turn: (id) => [
        prompted(id),
        stepStarted(),
        stepFailed("Recovered transport error"),
        retryScheduled(),
        settled(),
        {
          id: "evt_text",
          created: 2,
          type: "session.text.ended",
          durable: { aggregateID: "ses_1", seq: 2, version: 1 },
          data: { sessionID: "ses_1", assistantMessageID: "msg_2", ordinal: 0, text: "Training finished." },
        },
        settled(),
      ],
    })
    const events = jsonLines(output.stdout)
    expect(output.exitCode).toBe(0)
    expect(events.filter((event) => event.type === "error")).toEqual([])
    expect(events.find((event) => event.type === "retry")).toEqual({
      type: "retry",
      timestamp: 3,
      sessionID: "ses_1",
      messageID: "msg_assistant",
      attempt: 1,
      nextRetryAt: 2003,
      error: { type: "provider.transport", message: "Recovered transport error" },
    })
    expect(output.stdout).toContain("Training finished.")
    expect(lists).toEqual([])
  })

  test("prints a retry line in text output", async () => {
    const output = await capture({
      turn: (id) => [prompted(id), stepStarted(), retryScheduled(), settled()],
      messages: recoveredMessages("succeeded"),
    })
    expect(output.exitCode).toBe(0)
    expect(output.stderr).toContain("retrying (attempt 1): Recovered transport error")
    expect(output.stderr).not.toContain("Error:")
  })

  test("V1 compatibility does not report retries", async () => {
    const output = await capture({
      compatibility: "v1",
      format: "json",
      turn: (id) => [prompted(id), retryScheduled(), settled()],
    })
    expect(output).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  for (const live of [true, false]) {
    test(`a final failure exits 1 with one error (${live ? "live event" : "live event dropped"})`, async () => {
      const output = await capture({
        format: "json",
        turn: (messageID) => [
          prompted(messageID),
          stepFailed("Recovered transport error"),
          ...(live ? [executionFailed("Execution failed")] : []),
        ],
        messages: recoveredMessages("failed"),
        ...(live ? {} : { wait: () => Promise.resolve() }),
      })
      expect(output.exitCode).toBe(1)
      expect(jsonLines(output.stdout).filter((event) => event.type === "error")).toEqual([
        expect.objectContaining({ error: expect.objectContaining({ message: "Execution failed" }) }),
      ])
    })

    test(`an interruption from elsewhere exits 1 with one error (${live ? "live event" : "live event dropped"})`, async () => {
      const output = await capture({
        format: "json",
        turn: (messageID) => [prompted(messageID), ...(live ? [settled("interrupted")] : [])],
        messages: recoveredMessages("interrupted"),
        ...(live ? {} : { wait: () => Promise.resolve() }),
      })
      expect(output.exitCode).toBe(1)
      expect(jsonLines(output.stdout).filter((event) => event.type === "error")).toEqual([
        expect.objectContaining({
          error: { type: "aborted", message: live ? "Session interrupted: user" : "Session interrupted" },
        }),
      ])
    })
  }

  test("only the first idle marker after the prompt decides the outcome", async () => {
    const output = await capture({
      format: "json",
      turn: (id) => [prompted(id)],
      wait: () => Promise.resolve(),
      messages: (messageID) => [
        idleMessage("failed", "msg_later_idle"),
        { id: "msg_other_prompt", type: "user", text: "another client", time: { created: 6 } },
        ...recoveredMessages("succeeded")(messageID),
        idleMessage("failed", "msg_previous_idle"),
      ],
    })
    expect(output.exitCode).toBe(0)
    expect(output.stdout).not.toContain('"type":"error"')
  })

  test("a failed reply to finished background work exits 1", async () => {
    const lists: ExperimentalJobListOutput[] = [[shellJob("sh_train", "python train.py")], []]
    const output = await capture({
      format: "json",
      jobs: () => lists.shift() ?? [],
      turn: (id) => [prompted(id), settled(), executionFailed("Execution failed")],
      messages: (messageID) => [
        idleMessage("failed"),
        { id: "msg_notice", type: "synthetic", text: "<shell>done</shell>", time: { created: 6 } },
        ...recoveredMessages("succeeded")(messageID),
      ],
    })
    expect(output.exitCode).toBe(1)
    expect(jsonLines(output.stdout).filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ message: "Execution failed" }) }),
    ])
  })

  test("a prompt left in the inbox by a failure before promotion does not hang", async () => {
    const output = await capture({
      format: "json",
      turn: () => [executionFailed("instructions unavailable")],
      messages: () => [],
      inbox: (sessionID) => (sessionID === "ses_1" ? [{ id: "msg_prompt" }] : []),
    })
    expect(output.exitCode).toBe(1)
    expect(jsonLines(output.stdout)).toEqual([
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: "instructions unavailable" }),
      }),
    ])
  })

  test("exits 1 when neither an idle marker nor a live terminal event records the outcome", async () => {
    const output = await capture({
      format: "json",
      turn: (id) => [prompted(id)],
      wait: () => Promise.resolve(),
      messages: (messageID) => recoveredMessages("succeeded")(messageID).slice(1),
    })
    expect(output.exitCode).toBe(1)
    expect(jsonLines(output.stdout).filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ message: "Session ended without a recorded outcome" }),
      }),
    ])
  })

  test("Ctrl-C exits 130 without reporting the interrupted outcome", async () => {
    const idle = Promise.withResolvers<void>()
    const running = capture({
      format: "json",
      turn: (id) => [prompted(id)],
      wait: () => idle.promise,
      messages: recoveredMessages("interrupted"),
    })
    await Bun.sleep(5)
    process.emit("SIGINT")
    idle.resolve()
    const output = await running
    expect(output.exitCode).toBe(130)
    expect(output.stdout).not.toContain('"type":"error"')
  })

  test("a rejected permission continues and a cancelled form exits 1 without another error", async () => {
    const permission: V2Event = {
      id: "evt_permission",
      created: 2,
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["rm -rf build"] },
    }
    const rejected = await capture({
      format: "json",
      turn: (id) => [prompted(id), permission, settled()],
      messages: recoveredMessages("succeeded"),
    })
    expect(rejected.exitCode).toBe(0)
    expect(rejected.stderr).toContain("auto-rejecting")
    expect(rejected.stdout).not.toContain('"type":"error"')

    const cancelled = await capture({
      format: "json",
      turn: (id) => [prompted(id), formCreated(form("frm_live", "ses_1")), settled("interrupted")],
      messages: recoveredMessages("interrupted"),
    })
    expect(cancelled.exitCode).toBe(1)
    expect(cancelled.stdout).not.toContain('"type":"error"')
  })

  test("cancels session and global form blockers and exits on pre-promotion interrupt", async () => {
    const sdk = await run({
      pendingForms: [form("frm_pending", "ses_1"), form("frm_pending_global", "global")],
      // No prompted event: the execution settles interrupted before promotion,
      // which must not leave the consume loop waiting forever.
      turn: () => [formCreated(form("frm_live", "global")), settled("interrupted")],
    })
    const globalOptions = {
      headers: {
        "x-opencode-directory": "%2Fwork%20tree",
      },
    }
    expect(sdk.session.form.cancel).toHaveBeenCalledWith({ sessionID: "global", formID: "frm_live" }, globalOptions)
    expect(sdk.session.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(sdk.session.form.cancel).toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_pending_global" },
      globalOptions,
    )
    expect(sdk.form.list).toHaveBeenCalledWith({
      location: { directory: "/work tree" },
    })
    expect(process.exitCode).toBe(1)
  })

  test("attach mode cancels only session-owned forms", async () => {
    const sdk = await run({
      attached: true,
      pendingForms: [form("frm_pending", "ses_1"), form("frm_pending_global", "global")],
      turn: (messageID) => [formCreated(form("frm_live", "global")), prompted(messageID), settled()],
    })
    expect(sdk.session.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(sdk.form.list).not.toHaveBeenCalled()
    expect(sdk.session.form.cancel).not.toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_live" },
      expect.anything(),
    )
    expect(sdk.session.form.cancel).not.toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_pending_global" },
      expect.anything(),
    )
    expect(process.exitCode).toBe(1)
  })

  test("V1 JSON output flushes step_start before an unrelated step failure", async () => {
    const output = await capture({
      compatibility: "v1",
      format: "json",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted(),
        stepFailed("Provider request failed"),
        executionFailed("Provider request failed"),
      ],
    })

    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ type: "step_start", part: expect.objectContaining({ type: "step-start" }) }),
      expect.objectContaining({
        type: "error",
        error: { type: "provider.transport", message: "Provider request failed" },
      }),
    ])
    expect(output.stderr).toBe("")
    const sdk = await run({ compatibility: "v1", turn: (messageID) => [prompted(messageID), settled()] })
    expect(sdk.experimental.session.wait).not.toHaveBeenCalled()
    expect(sdk.message.list).not.toHaveBeenCalled()
  })

  test("V1 default output flushes step_start before an unrelated execution failure", async () => {
    const output = await capture({
      compatibility: "v1",
      turn: (messageID) => [prompted(messageID), stepStarted(), executionFailed("Execution failed")],
    })

    expect(output.stdout).toBe("")
    expect(output.stderr).toContain("> build · test-model")
    expect(output.stderr).toContain("Error: \u001b[0mExecution failed")
    expect(output.stderr.indexOf("> build · test-model")).toBeLessThan(output.stderr.indexOf("Execution failed"))
  })

  test("V1 preserves terminal-finish failure suppression before content", async () => {
    const output = await capture({
      compatibility: "v1",
      format: "json",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted(),
        stepFailed("The provider response ended unexpectedly."),
        executionFailed("The provider response ended unexpectedly."),
      ],
    })

    expect(output).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  test("renders a native terminal failure snapshot when live progress was missed", async () => {
    const rendered: SessionMessageAssistantTool[] = []
    const failed: SessionMessageAssistantTool[] = []
    await capture({
      turn: (inboxID) => failedTool(inboxID).filter((event) => event.type !== "session.tool.progress"),
      renderTool: (part) => {
        rendered.push(part)
        return Promise.resolve()
      },
      renderToolError: (part) => {
        failed.push(part)
        return Promise.resolve()
      },
    })

    expect(rendered).toMatchObject([
      {
        id: "call_failed_tool",
        state: {
          status: "completed",
          metadata: { checkpoint: 1 },
          content: [{ type: "text", text: "partial output" }],
        },
      },
    ])
    expect(failed).toMatchObject([
      {
        id: "call_failed_tool",
        state: {
          status: "error",
          metadata: { checkpoint: 1 },
          content: [{ type: "text", text: "partial output" }],
          error: { message: "tool failed" },
        },
      },
    ])
  })

  test("keeps failed tool partial output out of the explicit V1 JSON bridge shape", async () => {
    const output = await capture({ compatibility: "v1", format: "json", turn: failedTool })
    const events = output.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_use",
      part: {
        type: "tool",
        id: "call_failed_tool",
        tool: "shell",
        state: {
          status: "error",
          input: { command: "printf partial && false" },
          error: "tool failed",
        },
      },
    })
    expect(events[0].part.state.output).toBeUndefined()
    expect(events[0].part.state.metadata.metadata).toBeUndefined()
    expect(events[0].part.state.metadata.content).toBeUndefined()
    expect(output.stderr).toBe("")
  })

  test("waits for a background shell and streams the reply it wakes", async () => {
    const lists: ExperimentalJobListOutput[] = [[shellJob("sh_train", "python train.py")], []]
    const output = await capture({
      format: "json",
      jobs: () => lists.shift() ?? [],
      turn: (id) => [
        prompted(id),
        settled(),
        {
          id: "evt_text",
          created: 2,
          type: "session.text.ended",
          durable: { aggregateID: "ses_1", seq: 2, version: 1 },
          data: { sessionID: "ses_1", assistantMessageID: "msg_2", ordinal: 0, text: "Training finished." },
        },
        settled(),
      ],
    })
    expect(output.stdout).toContain("Training finished.")
  })

  test("waits for a background shell owned by a subagent", async () => {
    const lists: ExperimentalJobListOutput[] = [[{ ...shellJob("sh_test", "pytest"), sessionID: "ses_child" }], []]
    const sdk = await run({
      jobs: () => lists.shift() ?? [],
      turn: (id) => [
        prompted(id),
        settled(),
        {
          id: "evt_child_done",
          created: 2,
          type: "session.execution.succeeded",
          durable: { aggregateID: "ses_child", seq: 1, version: 1 },
          data: { sessionID: "ses_child" },
        },
      ],
    })
    expect(sdk.experimental.job.list).toHaveBeenCalledWith({ sessionID: "ses_1", descendants: true })
    expect(lists).toEqual([])
  })

  test("Ctrl-C while waiting on a background subagent exits with code 130", async () => {
    const running = run({ turn: (id) => [prompted(id), settled()], jobs: () => [subagentJob] })
    expect(await Promise.race([running.then(() => "exited"), Bun.sleep(20).then(() => "waiting")])).toBe("waiting")
    process.emit("SIGINT")
    await running
    expect(process.exitCode).toBe(130)
  })
})
