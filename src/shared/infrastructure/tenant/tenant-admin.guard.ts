import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { USER_ROLE } from './user-role.js';

@Injectable()
export class TenantAdminGuard implements CanActivate {
  constructor(private readonly auth: TenantAuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const tenantParam = request.params.tenantId;
    const tenantId = typeof tenantParam === 'string' ? tenantParam.trim() : '';
    if (!tenantId) throw new UnauthorizedException('Tenant ID is required');
    const user = await this.auth.authenticate(request);
    if (user.role !== USER_ROLE.SUPER_ADMIN &&
        !user.tenantRoles.some((membership) => membership.tenantId === tenantId && membership.role === USER_ROLE.TENANT_ADMIN)) {
      throw new ForbiddenException('Tenant administrator access is required');
    }
    request.user = { id: user.id, username: user.username,
      role: user.role === USER_ROLE.SUPER_ADMIN ? USER_ROLE.SUPER_ADMIN : USER_ROLE.TENANT_ADMIN };
    request.tenantId = tenantId;
    return true;
  }
}
