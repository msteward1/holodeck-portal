/**
 * VMware PowerCLI in the container: downloaded into the data volume on first start (deploy/container/install-powercli.sh;
 * Broadcom's licence doesn't allow shipping it in the image). Portal-local vCenter tasks need it; until it is
 * installed they are refused with a clear reason. Installations without HP_PS_MODULES (development hosts) are
 * assumed to have PowerCLI installed normally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from './labs.js';

const statusSchema = z.object({
  state: z.enum(['installing', 'ready', 'failed']),
  version: z.string(),
  message: z.string().default(''),
  at: z.string().default(''),
});
export type PowerCliStatus = z.infer<typeof statusSchema>;

export function powerCliStatus(): PowerCliStatus | null {
  const modules = process.env.HP_PS_MODULES;
  if (!modules) return null;
  try {
    return statusSchema.parse(JSON.parse(fs.readFileSync(path.join(path.dirname(modules), 'powercli.json'), 'utf8')));
  } catch {
    return { state: 'installing', version: process.env.POWERCLI_VERSION ?? '', message: 'Waiting for the PowerCLI download to start', at: '' };
  }
}

/** For jobs that run PowerCLI inside the portal (vCenter inventory, deploying or deleting Holorouters). */
export function assertPowerCli() {
  const s = powerCliStatus();
  if (!s || s.state === 'ready') return;
  throw new HttpError(
    409,
    s.state === 'installing'
      ? `VMware PowerCLI is still being downloaded (first start of the portal). Try again in a few minutes.`
      : `VMware PowerCLI could not be downloaded from the PowerShell Gallery: ${s.message} The portal retries every 10 minutes; see the operations guide for offline installation.`,
  );
}
