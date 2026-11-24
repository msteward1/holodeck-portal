import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/session.js';
import { audit } from '../audit.js';
import { certificateStatus, discardCsr, generateCsr, installSigned, installUploaded, regenerateSelfSigned, rollback } from '../certificate.js';

const hostOrIp = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(\.\d{1,3}){3}$/, 'Host names, *.wildcards or IPv4 addresses only');
const dnText = z.string().trim().max(64).regex(/^[^\n\r]*$/).optional();
const pem = z.string().max(256 * 1024);

/** Settings → Certificate (administrators). */
export async function certificateRoutes(app: FastifyInstance) {
  app.get('/api/admin/certificate', async (req) => {
    requireAdmin(req);
    return certificateStatus();
  });

  app.post('/api/admin/certificate/csr', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        commonName: hostOrIp,
        altNames: z.array(hostOrIp).max(50).default([]),
        organization: dnText,
        organizationalUnit: dnText,
        locality: dnText,
        state: dnText,
        country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, 'Two-letter country code').optional(),
        keyType: z.enum(['rsa-2048', 'rsa-3072', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384']).default('rsa-2048'),
      })
      .parse(req.body);
    const csr = await generateCsr(body);
    audit(admin.id, 'certificate.csr', null, { commonName: body.commonName, altNames: body.altNames, keyType: body.keyType }, req.ip);
    return { csr, status: certificateStatus() };
  });

  app.delete('/api/admin/certificate/csr', async (req) => {
    const admin = requireAdmin(req);
    discardCsr();
    audit(admin.id, 'certificate.csr.discard', null, null, req.ip);
    return { status: certificateStatus() };
  });

  app.post('/api/admin/certificate/install', async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({ certificate: pem, allowOtherName: z.boolean().default(false) }).parse(req.body);
    const cert = await installSigned(body.certificate, { allowOtherName: body.allowOtherName });
    audit(admin.id, 'certificate.install', null, { subject: cert.subject, issuer: cert.issuer, sha256: cert.sha256, notAfter: cert.notAfter }, req.ip);
    return { certificate: cert, status: certificateStatus() };
  });

  app.post('/api/admin/certificate/upload', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        certificate: pem.optional(),
        privateKey: pem.optional(),
        pfxBase64: z.string().max(512 * 1024).optional(),
        passphrase: z.string().max(256).optional(),
        allowOtherName: z.boolean().default(false),
      })
      .refine((b) => b.pfxBase64 || (b.certificate && b.privateKey), 'Give the certificate and its private key, or a PFX file.')
      .parse(req.body);
    const cert = await installUploaded(body);
    audit(admin.id, 'certificate.upload', null, { subject: cert.subject, issuer: cert.issuer, sha256: cert.sha256, notAfter: cert.notAfter, pfx: Boolean(body.pfxBase64) }, req.ip);
    return { certificate: cert, status: certificateStatus() };
  });

  app.post('/api/admin/certificate/self-signed', async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({ altNames: z.array(hostOrIp).max(50).default([]) }).parse(req.body ?? {});
    const cert = await regenerateSelfSigned(body.altNames);
    audit(admin.id, 'certificate.self-signed', null, { names: cert.names, sha256: cert.sha256 }, req.ip);
    return { certificate: cert, status: certificateStatus() };
  });

  app.post('/api/admin/certificate/rollback', async (req) => {
    const admin = requireAdmin(req);
    const cert = await rollback();
    audit(admin.id, 'certificate.rollback', null, { subject: cert.subject, sha256: cert.sha256 }, req.ip);
    return { certificate: cert, status: certificateStatus() };
  });
}
