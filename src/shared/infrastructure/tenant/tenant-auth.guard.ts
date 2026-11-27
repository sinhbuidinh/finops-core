import { createHmac, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { TenantContext } from './tenant-context.js';

declare module 'express-serve-static-core' {
  interface Request { tenantId?: string; }
}

interface TenantJwtClaims {
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  tenant_id?: unknown;
  tenant_ids?: unknown;
  iss?: unknown;
  aud?: unknown;
}

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContext) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const claims = verifyBearerToken(request.headers.authorization, process.env.AUTH_JWT_SECRET);
    verifyConfiguredIssuerAndAudience(claims);

    const allowedTenants = getTenantIds(claims);
    const requestedTenant = request.headers['x-tenant-id'];
    const tenantId = typeof requestedTenant === 'string' ? requestedTenant.trim() : undefined;
    if (requestedTenant !== undefined && !tenantId) throw new UnauthorizedException('X-Tenant-Id must not be empty');
    if (tenantId && !allowedTenants.includes(tenantId)) {
      throw new ForbiddenException('The authenticated user is not a member of the requested tenant');
    }
    if (!tenantId && allowedTenants.length !== 1) {
      throw new UnauthorizedException('X-Tenant-Id is required when the token has multiple tenant memberships');
    }

    const resolvedTenantId = tenantId ?? allowedTenants[0]!;
    this.tenantContext.setTenantId(resolvedTenantId);
    request.tenantId = resolvedTenantId;
    return true;
  }
}

function verifyBearerToken(authorization: string | undefined, secret: string | undefined): TenantJwtClaims {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('AUTH_JWT_SECRET must be configured with at least 32 bytes');
  }
  if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token is required');

  const token = authorization.slice('Bearer '.length).trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new UnauthorizedException('Invalid bearer token');
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

  let header: unknown;
  let claims: unknown;
  let signature: Buffer;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
    signature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new UnauthorizedException('Invalid bearer token');
  }
  if (!isRecord(header) || header.alg !== 'HS256' || !isRecord(claims)) {
    throw new UnauthorizedException('Invalid bearer token');
  }

  const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedClaims}`).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new UnauthorizedException('Invalid bearer token');
  }

  const jwtClaims = claims as TenantJwtClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof jwtClaims.sub !== 'string' || !jwtClaims.sub.trim() ||
      typeof jwtClaims.exp !== 'number' || !Number.isFinite(jwtClaims.exp) || jwtClaims.exp <= now ||
      (jwtClaims.nbf !== undefined && (typeof jwtClaims.nbf !== 'number' || jwtClaims.nbf > now))) {
    throw new UnauthorizedException('Bearer token is expired or has invalid claims');
  }
  return jwtClaims;
}

function getTenantIds(claims: TenantJwtClaims): string[] {
  const values = claims.tenant_ids ?? (typeof claims.tenant_id === 'string' ? [claims.tenant_id] : undefined);
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new UnauthorizedException('Bearer token has no valid tenant membership');
  }
  return [...new Set(values as string[])];
}

function verifyConfiguredIssuerAndAudience(claims: TenantJwtClaims): void {
  const issuer = process.env.AUTH_JWT_ISSUER;
  if (issuer && claims.iss !== issuer) throw new UnauthorizedException('Bearer token has an invalid issuer');
  const audience = process.env.AUTH_JWT_AUDIENCE;
  if (audience) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) throw new UnauthorizedException('Bearer token has an invalid audience');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
