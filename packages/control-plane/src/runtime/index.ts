import { config } from '../config.js';
import { DockerRuntime } from './docker.js';
import type { LabRuntime } from './types.js';

let _runtime: LabRuntime | null = null;

export function getRuntime(): LabRuntime {
  if (_runtime) return _runtime;
  switch (config.RUNTIME) {
    case 'docker':
      _runtime = new DockerRuntime();
      break;
    case 'mock':
      _runtime = makeMockRuntime();
      break;
    default:
      throw new Error(`Unknown RUNTIME: ${String(config.RUNTIME)}`);
  }
  return _runtime;
}

function makeMockRuntime(): LabRuntime {
  return {
    name: 'mock',
    async provision(req) {
      return { runtimeId: `mock-${req.instanceId}`, upstream: `${req.subdomain}:8080` };
    },
    async isReady() {
      return true;
    },
    async destroy() {
      /* noop */
    },
    async suspend() {
      /* noop */
    },
    async resume() {
      /* noop */
    },
    async destroyVolume() {
      /* noop */
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
}
