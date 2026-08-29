import crypto from 'crypto';
import { cleanEmail } from '../utils/validators.js';

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function getOnboardingSecret() {
  return process.env.ONBOARDING_TOKEN_SECRET || process.env.WEBHOOK_SECRET || process.env.STRIPE_SECRET_KEY;
}

export function createOnboardingToken(email, plan, ttlMs = 30 * 60 * 1000) {
  const payload = { email: cleanEmail(email), plan, exp: Date.now() + ttlMs };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', getOnboardingSecret()).update(payloadPart).digest('base64url');
  return `${payloadPart}.${signature}`;
}

export function verifyOnboardingToken(token) {
  const [payloadPart, signature] = String(token || '').split('.');
  if (!payloadPart || !signature) throw new Error('Invalid onboarding token');

  const expectedSignature = crypto.createHmac('sha256', getOnboardingSecret()).update(payloadPart).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid onboarding token signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadPart));
  if (!payload.email || !payload.plan || !payload.exp || Date.now() > payload.exp) {
    throw new Error('Onboarding token expired');
  }
  return payload;
}
