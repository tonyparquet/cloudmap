import {
  DescribeUserCommand,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ListGroupsCommand,
} from '@aws-sdk/client-identitystore';
import {
  DescribeOrganizationCommand,
  DescribePolicyCommand,
  ListAccountsForParentCommand,
  ListDelegatedAdministratorsCommand,
  ListDelegatedServicesForAccountCommand,
  ListOrganizationalUnitsForParentCommand,
  ListPoliciesCommand,
  ListRootsCommand,
  ListTargetsForPolicyCommand,
  OrganizationsClient,
} from '@aws-sdk/client-organizations';
import {
  DescribePermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListAccountsForProvisionedPermissionSetCommand,
  ListInstancesCommand,
  ListManagedPoliciesInPermissionSetCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from '@aws-sdk/client-sso-admin';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { rawSnapshotSchema } from '@carto/core';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAccount } from '../src/index.ts';

const MGMT = '111111111111';
const sts = mockClient(STSClient);
const orgs = mockClient(OrganizationsClient);
const sso = mockClient(SSOAdminClient);
const ids = mockClient(IdentitystoreClient);
const awsError = (name: string, message: string) =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });
const scan = (account: string, services: string[]) =>
  scanAccount({
    profileId: 'p',
    accountId: account,
    regions: ['eu-west-3'],
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'exemple' },
    services,
    throttleBackoffMs: 1,
  });
const caller = (account: string) =>
  sts
    .on(GetCallerIdentityCommand)
    .resolves({ Account: account, Arn: `arn:aws:iam::${account}:user/lecteur`, UserId: 'U' });
const organization = { Id: 'o-exemple', MasterAccountId: MGMT, FeatureSet: 'ALL' as const };

beforeEach(() => {
  orgs.onAnyCommand().resolves({});
  sso.onAnyCommand().resolves({});
  ids.onAnyCommand().resolves({});
});
afterEach(() => {
  for (const m of [sts, orgs, sso, ids]) m.reset();
});

describe('collecteur AWS Organizations', () => {
  it('compte de gestion : arbre OU récursif paginé, politiques, administrateurs délégués', async () => {
    caller(MGMT);
    orgs.on(DescribeOrganizationCommand).resolves({ Organization: organization });
    orgs.on(ListRootsCommand).resolves({
      Roots: [
        { Id: 'r-root', Name: 'Root', PolicyTypes: [{ Type: 'SERVICE_CONTROL_POLICY', Status: 'ENABLED' }] },
      ],
    });
    const accounts: Record<string, { Accounts: object[]; NextToken?: string }[]> = {
      'r-root': [
        { Accounts: [{ Id: MGMT, Name: 'gestion', Status: 'ACTIVE' }], NextToken: 'suite' },
        { Accounts: [{ Id: '222222222222', Name: 'outils', Status: 'ACTIVE' }] },
      ],
      'ou-prod': [{ Accounts: [{ Id: '333333333333', Name: 'prod', Status: 'ACTIVE' }] }],
      'ou-prod-eu': [{ Accounts: [{ Id: '444444444444', Name: 'prod-eu', Status: 'SUSPENDED' }] }],
    };
    orgs.on(ListAccountsForParentCommand).callsFake((input: { ParentId: string; NextToken?: string }) => {
      const pages = accounts[input.ParentId] ?? [{ Accounts: [] }];
      return input.NextToken ? pages[1] : pages[0];
    });
    const ous: Record<string, object[]> = {
      'r-root': [{ Id: 'ou-prod', Name: 'Production' }],
      'ou-prod': [{ Id: 'ou-prod-eu', Name: 'Europe' }],
    };
    orgs
      .on(ListOrganizationalUnitsForParentCommand)
      .callsFake((input: { ParentId: string }) => ({ OrganizationalUnits: ous[input.ParentId] ?? [] }));
    orgs.on(ListPoliciesCommand).resolves({
      Policies: [
        { Id: 'p-FullAWSAccess', Name: 'FullAWSAccess', Type: 'SERVICE_CONTROL_POLICY', AwsManaged: true },
        { Id: 'p-regions', Name: 'RegionsAutorisees', Type: 'SERVICE_CONTROL_POLICY', AwsManaged: false },
      ],
    });
    orgs.on(DescribePolicyCommand).resolves({ Policy: { Content: '{"Version":"2012-10-17"}' } });
    orgs.on(ListTargetsForPolicyCommand).callsFake((input: { PolicyId: string }) => ({
      Targets:
        input.PolicyId === 'p-regions'
          ? [{ TargetId: 'ou-prod', Type: 'ORGANIZATIONAL_UNIT', Name: 'Production' }]
          : [{ TargetId: 'r-root', Type: 'ROOT', Name: 'Root' }],
    }));
    orgs
      .on(ListDelegatedAdministratorsCommand)
      .resolves({ DelegatedAdministrators: [{ Id: '222222222222' }] });
    orgs
      .on(ListDelegatedServicesForAccountCommand)
      .resolves({ DelegatedServices: [{ ServicePrincipal: 'securityhub.amazonaws.com' }] });

    const snap = await scan(MGMT, ['organizations']);
    expect(snap.errors).toEqual([]);
    const of = (type: string) => snap.resources.filter((r) => r.type === `AWS::Organizations::${type}`);
    expect(of('Organization').map((r) => r.id)).toEqual(['o-exemple']);
    expect(of('Root').map((r) => r.id)).toEqual(['r-root']);
    expect(of('OrganizationalUnit').map((r) => [r.id, (r.raw as { _parentId: string })._parentId])).toEqual([
      ['ou-prod', 'r-root'],
      ['ou-prod-eu', 'ou-prod'],
    ]);
    expect(of('Account').map((r) => r.id)).toEqual([MGMT, '222222222222', '333333333333', '444444444444']);
    expect(of('Account')[1]?.raw).toMatchObject({ _delegatedServices: ['securityhub.amazonaws.com'] });
    expect(of('Account')[3]?.raw).toMatchObject({ _parentId: 'ou-prod-eu', Status: 'SUSPENDED' });
    const scp = of('Policy').find((p) => p.id === 'p-regions');
    expect(scp?.raw).toMatchObject({
      Content: '{"Version":"2012-10-17"}',
      _targets: [{ TargetId: 'ou-prod' }],
    });
    expect(orgs.commandCalls(ListPoliciesCommand)[0]?.args[0].input).toEqual({
      Filter: 'SERVICE_CONTROL_POLICY',
    });
    expect(snap.resources.every((r) => r.region === 'global')).toBe(true);
    expect(() => rawSnapshotSchema.parse(snap)).not.toThrow();
  });

  it('compte membre : organisation seule, marquée « membre », sans erreur de scan', async () => {
    caller('999999999999');
    orgs.on(DescribeOrganizationCommand).resolves({ Organization: organization });
    orgs.on(ListRootsCommand).rejects(awsError('AccessDeniedException', 'You don’t have permissions'));
    const snap = await scan('999999999999', ['organizations']);
    expect(snap.resources.map((r) => [r.type, (r.raw as { _scope?: string })._scope])).toEqual([
      ['AWS::Organizations::Organization', 'membre'],
    ]);
    expect(snap.errors).toEqual([]);
  });

  it('organisation absente : rien, sans erreur ; refus d’accès : permission manquante', async () => {
    caller(MGMT);
    orgs
      .on(DescribeOrganizationCommand)
      .rejects(awsError('AWSOrganizationsNotInUseException', 'not in an organization'));
    const none = await scan(MGMT, ['organizations']);
    expect(none.resources).toEqual([]);
    expect(none.errors).toEqual([]);

    orgs.on(DescribeOrganizationCommand).rejects(awsError('AccessDeniedException', 'denied'));
    const denied = await scan(MGMT, ['organizations']);
    expect(denied.errors[0]?.message).toBe('Permission manquante : organizations:DescribeOrganization');
  });
});

describe('collecteur IAM Identity Center', () => {
  it('permission sets, affectations, groupes (nombre de membres) et utilisateurs à affectation directe', async () => {
    caller(MGMT);
    const InstanceArn = 'arn:aws:sso:::instance/ssoins-1';
    const ps = 'arn:aws:sso:::permissionSet/ssoins-1/ps-admin';
    sso.on(ListInstancesCommand).resolves({ Instances: [{ InstanceArn, IdentityStoreId: 'd-1' }] });
    sso.on(ListPermissionSetsCommand).resolves({ PermissionSets: [ps] });
    sso
      .on(DescribePermissionSetCommand)
      .resolves({ PermissionSet: { Name: 'AdministratorAccess', PermissionSetArn: ps } });
    sso
      .on(ListManagedPoliciesInPermissionSetCommand)
      .resolves({ AttachedManagedPolicies: [{ Name: 'AdministratorAccess' }] });
    sso.on(ListAccountsForProvisionedPermissionSetCommand).resolves({ AccountIds: ['222222222222'] });
    sso.on(ListAccountAssignmentsCommand).resolves({
      AccountAssignments: [
        { AccountId: '222222222222', PermissionSetArn: ps, PrincipalType: 'GROUP', PrincipalId: 'g-1' },
        { AccountId: '222222222222', PermissionSetArn: ps, PrincipalType: 'USER', PrincipalId: 'u-1' },
      ],
    });
    ids.on(ListGroupsCommand).resolves({
      Groups: [
        { GroupId: 'g-1', DisplayName: 'Admins', IdentityStoreId: 'd-1', GroupArn: 'arn:g-1', Revision: '1' },
      ],
    });
    ids.on(ListGroupMembershipsCommand).resolves({
      GroupMemberships: ['m-1', 'm-2'].map((MembershipId) => ({
        MembershipId,
        IdentityStoreId: 'd-1',
        MembershipArn: `arn:${MembershipId}`,
      })),
    });
    ids.on(DescribeUserCommand).resolves({
      UserId: 'u-1',
      UserName: 'astreinte',
      DisplayName: 'Astreinte',
      IdentityStoreId: 'd-1',
      Emails: [{ Value: 'ne-pas-collecter@exemple.invalid' }],
    });

    const snap = await scan(MGMT, ['identitycenter']);
    expect(snap.errors).toEqual([]);
    const types = snap.resources.map((r) => r.type);
    expect(types).toContain('AWS::SSO::Instance');
    expect(snap.resources.find((r) => r.type === 'AWS::SSO::PermissionSet')?.raw).toMatchObject({
      Name: 'AdministratorAccess',
      _accounts: ['222222222222'],
      _managedPolicies: [{ Name: 'AdministratorAccess' }],
    });
    expect(types.filter((t) => t === 'AWS::SSO::AccountAssignment')).toHaveLength(2);
    expect(snap.resources.find((r) => r.type === 'AWS::IdentityStore::Group')?.raw).toMatchObject({
      DisplayName: 'Admins',
      _memberCount: 2,
    });
    const user = snap.resources.find((r) => r.type === 'AWS::IdentityStore::User');
    expect(user?.raw).toEqual({
      UserId: 'u-1',
      UserName: 'astreinte',
      DisplayName: 'Astreinte',
      IdentityStoreId: 'd-1',
    });
    expect(JSON.stringify(snap)).not.toContain('ne-pas-collecter');
    expect(ids.commandCalls(DescribeUserCommand)).toHaveLength(1);
  });
});
