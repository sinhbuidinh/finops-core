import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { LoginService } from './login.service.js';
import { UserManagementService } from './user-management.service.js';
import { SuperAdminGuard } from './super-admin.guard.js';
import { TenantAdminGuard } from './tenant-admin.guard.js';
import type { TenantAssignment } from './auth-user.repository.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly loginService: LoginService, private readonly userManagement: UserManagementService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() body: { username?: unknown; password?: unknown }) {
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string' || !body.username || !body.password) {
      throw new UnauthorizedException('Invalid username or password');
    }
    return this.loginService.login(body.username, body.password);
  }

  @Post('bootstrap')
  @HttpCode(201)
  bootstrap(@Body() body: { username?: unknown; password?: unknown }, @Headers('x-bootstrap-token') bootstrapToken?: string) {
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string' || typeof bootstrapToken !== 'string') {
      throw new UnauthorizedException('Bootstrap credentials are required');
    }
    return this.userManagement.bootstrap({ username: body.username, password: body.password, bootstrapToken });
  }

  @Post('users')
  @UseGuards(SuperAdminGuard)
  @HttpCode(201)
  createUser(@Body() body: { username?: unknown; password?: unknown; role?: unknown; tenants?: unknown }) {
    if (typeof body?.username !== 'string' || typeof body.password !== 'string' ||
        body.role !== undefined ||
        !Array.isArray(body.tenants) || body.tenants.some((tenant) => typeof tenant !== 'object' || tenant === null ||
          typeof (tenant as { tenantId?: unknown }).tenantId !== 'string' || typeof (tenant as { role?: unknown }).role !== 'string')) {
      throw new BadRequestException('Invalid user details');
    }
    return this.userManagement.createUser({ username: body.username, password: body.password, tenants: body.tenants as TenantAssignment[] });
  }

  @Get('tenants/:tenantId/users')
  @UseGuards(TenantAdminGuard)
  listTenantUsers(@Param('tenantId') tenantId: string) {
    return this.userManagement.listTenantUsers(tenantId);
  }

  @Patch('tenants/:tenantId/users/:userId')
  @UseGuards(TenantAdminGuard)
  updateTenantUserRole(@Param('tenantId') tenantId: string, @Param('userId') userId: string, @Body() body: { role?: unknown }) {
    if (typeof body?.role !== 'string') throw new BadRequestException('A tenant role is required');
    return this.userManagement.updateTenantUserRole(userId, tenantId, body.role);
  }
}
