import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AuthController } from './auth.controller.js';
import { LoginService } from './login.service.js';
import { UserManagementService } from './user-management.service.js';
import { SuperAdminGuard } from './super-admin.guard.js';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { TenantAdminGuard } from './tenant-admin.guard.js';
import { USER_ROLE } from './user-role.js';

describe('AuthController (HTTP)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const builder = Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: LoginService, useValue: { login: vi.fn().mockResolvedValue({ accessToken: 'a.b.c', tokenType: 'Bearer', expiresIn: 3600 }) } },
        { provide: UserManagementService, useValue: {
          bootstrap: vi.fn().mockResolvedValue({ id: 'admin-1', username: 'root', role: USER_ROLE.SUPER_ADMIN, tenantRoles: [] }),
          createUser: vi.fn().mockResolvedValue({ id: 'user-2', username: 'staff', tenantRoles: [{ tenantId: 'tenant-1', role: USER_ROLE.OPERATOR }] }),
          listTenantUsers: vi.fn().mockResolvedValue([{ id: 'user-2', username: 'staff', role: USER_ROLE.OPERATOR }]),
          updateTenantUserRole: vi.fn().mockResolvedValue({ id: 'user-2', username: 'staff', role: USER_ROLE.APPROVER }),
        } },
        SuperAdminGuard,
        TenantAdminGuard,
        { provide: TenantAuthGuard, useValue: { authenticate: vi.fn() } },
      ],
    }).overrideGuard(SuperAdminGuard).useValue({ canActivate: () => true })
      .overrideGuard(TenantAdminGuard).useValue({ canActivate: () => true });
    const module = await builder.compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => app?.close());

  it('returns a bearer access token from POST /auth/login', async () => {
    await request(app.getHttpServer()).post('/auth/login')
      .send({ username: 'operator', password: 'a-long-test-password' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.tokenType).toBe('Bearer');
        expect(body.accessToken.split('.')).toHaveLength(3);
        expect(body.expiresIn).toBe(3600);
      });
  });

  it('rejects missing credentials', async () => {
    await request(app.getHttpServer()).post('/auth/login').send({}).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ username: '', password: 'secret' }).expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ username: 'root', password: 4 }).expect(401);
  });

  it('validates bootstrap and user provisioning payloads', async () => {
    await request(app.getHttpServer()).post('/auth/bootstrap').send({ username: 'root', password: 'long-enough-password' }).expect(401);
    await request(app.getHttpServer()).post('/auth/bootstrap').set('x-bootstrap-token', 'setup').send({ username: 'root' }).expect(401);
    await request(app.getHttpServer()).post('/auth/users').send({ username: 'root', password: 'secret', tenants: null }).expect(400);
    await request(app.getHttpServer()).post('/auth/users').send({ username: 'root', password: 'secret', role: 'super-admin', tenants: [] }).expect(400);
    await request(app.getHttpServer()).post('/auth/users').send({ username: 'root', password: 'secret', tenants: [null] }).expect(400);
    await request(app.getHttpServer()).post('/auth/users').send({ username: 'root', password: 'secret', tenants: [{ tenantId: 1, role: 'operator' }] }).expect(400);
    await request(app.getHttpServer()).patch('/auth/tenants/t/users/u').send({}).expect(400);
    await request(app.getHttpServer()).post('/auth/bootstrap').set('x-bootstrap-token', 'setup')
      .send({ username: 'root', password: 'long-enough-password' }).expect(201);
  });

  it('exposes user provisioning for an authenticated administrator', async () => {
    await request(app.getHttpServer()).post('/auth/users')
      .send({ username: 'staff', password: 'a-long-test-password', tenants: [{ tenantId: 'tenant-1', role: USER_ROLE.OPERATOR }] })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ tenantRoles: [{ tenantId: 'tenant-1', role: USER_ROLE.OPERATOR }] }));
  });

  it('lists tenant users and updates a user role within the tenant', async () => {
    await request(app.getHttpServer()).get('/auth/tenants/tenant-1/users')
      .expect(200).expect(({ body }) => expect(body[0].role).toBe(USER_ROLE.OPERATOR));
    await request(app.getHttpServer()).patch('/auth/tenants/tenant-1/users/user-2')
      .send({ role: USER_ROLE.APPROVER })
      .expect(200).expect(({ body }) => expect(body.role).toBe(USER_ROLE.APPROVER));
  });
});
