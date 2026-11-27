import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { USER_ROLE } from './user-role.js';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly auth: TenantAuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = await this.auth.authenticate(request);
    if (!user.active) throw new ForbiddenException();
    if (user.role !== USER_ROLE.SUPER_ADMIN) throw new ForbiddenException('Super administrator access is required');
    request.user = { id: user.id, username: user.username, role: USER_ROLE.SUPER_ADMIN };
    return true;
  }
}
