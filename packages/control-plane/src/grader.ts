import { createHmac } from 'node:crypto';
import { GraderSpec, LabTemplateSpec } from '@labforge/shared';
import type { GraderCheckResult } from '@labforge/shared';
import type { LabInstance, LabTemplate, Launch, Tenant } from '@prisma/client';
import { prisma } from './db.js';
import { getRuntime } from './runtime/index.js';

export interface GradeInput {
  tenant: Tenant;
  template: LabTemplate;
  instance: LabInstance;
  launch?: Launch | null;
}

export interface GradeOutcome {
  id: string;
  score: number;
  maxScore: number;
  passed: boolean;
  checks: GraderCheckResult[];
  createdAt: Date;
}

/**
 * Run the template's grader against the running lab container.
 * Each check is executed via `runtime.exec` and scored independently.
 * Total score is sum of weights for passing checks; passed = score/maxScore >= passThreshold.
 * Results are persisted and (if a webhookUrl is set on the launch) emitted as
 * an HMAC-signed webhook.
 */
export async function gradeInstance(input: GradeInput): Promise<GradeOutcome> {
  const spec = LabTemplateSpec.parse(input.template.spec);
  if (!spec.grader) {
    throw new GraderError('grader_not_configured', 'Template has no grader defined.');
  }
  const grader = GraderSpec.parse(spec.grader);

  if (!input.instance.runtimeId) {
    throw new GraderError('instance_not_running', 'Instance has no runtime handle.');
  }
  if (input.instance.status !== 'ready' && input.instance.status !== 'idle') {
    throw new GraderError(
      'instance_not_ready',
      `Instance status is ${input.instance.status}; expected ready or idle.`,
    );
  }

  const runtime = getRuntime();
  const checks: GraderCheckResult[] = [];
  let score = 0;
  let maxScore = 0;

  for (const check of grader.checks) {
    maxScore += check.weight;
    const start = Date.now();
    try {
      const res = await runtime.exec(input.instance.runtimeId, {
        cmd: ['sh', '-lc', check.command],
        workdir: check.workdir ?? spec.workspaceDir,
        timeoutMs: check.timeoutSeconds * 1000,
      });
      const exitOk = !res.timedOut && res.exitCode === check.passExitCode;
      const stdoutOk = check.passStdoutRegex
        ? new RegExp(check.passStdoutRegex).test(res.stdout)
        : true;
      const passed = exitOk && stdoutOk;
      if (passed) score += check.weight;
      checks.push({
        id: check.id,
        passed,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
        error: res.timedOut ? 'timeout' : undefined,
      });
    } catch (err) {
      checks.push({
        id: check.id,
        passed: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = maxScore > 0 ? score / maxScore >= grader.passThreshold : false;

  const row = await prisma.gradingResult.create({
    data: {
      tenantId: input.tenant.id,
      instanceId: input.instance.id,
      launchId: input.launch?.id ?? null,
      templateId: input.template.id,
      score,
      maxScore,
      passed,
      checks: checks as unknown as object,
    },
  });

  // Fire-and-forget webhook so a slow LMS endpoint doesn't block grading.
  if (input.launch?.webhookUrl) {
    void emitGradedWebhook({
      url: input.launch.webhookUrl,
      secret: input.tenant.webhookSecret,
      payload: {
        event: 'lab.graded',
        launchId: input.launch.id,
        instanceId: input.instance.id,
        templateId: input.template.id,
        score,
        maxScore,
        passed,
        gradingResultId: row.id,
        createdAt: row.createdAt.toISOString(),
      },
    });
  }

  return {
    id: row.id,
    score,
    maxScore,
    passed,
    checks,
    createdAt: row.createdAt,
  };
}

export class GraderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GraderError';
  }
}

async function emitGradedWebhook(args: {
  url: string;
  secret: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const body = JSON.stringify(args.payload);
  const sig = createHmac('sha256', args.secret).update(body).digest('hex');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    await fetch(args.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-labforge-event': 'lab.graded',
        'x-labforge-signature': `sha256=${sig}`,
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {
    // Webhook delivery is best-effort. Retry queue is a future slice.
  }
}
