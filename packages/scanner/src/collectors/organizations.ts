import {
  IdentitystoreClient,
  DescribeUserCommand,
  paginateListGroupMemberships,
  paginateListGroups,
} from '@aws-sdk/client-identitystore';
import {
  DescribeOrganizationCommand,
  DescribePolicyCommand,
  OrganizationsClient,
  paginateListAccountsForParent,
  paginateListDelegatedAdministrators,
  paginateListDelegatedServicesForAccount,
  paginateListOrganizationalUnitsForParent,
  paginateListPolicies,
  paginateListRoots,
  paginateListTargetsForPolicy,
  type PolicyType,
} from '@aws-sdk/client-organizations';
import {
  DescribePermissionSetCommand,
  paginateListAccountAssignments,
  paginateListAccountsForProvisionedPermissionSet,
  paginateListInstances,
  paginateListManagedPoliciesInPermissionSet,
  paginateListPermissionSets,
  SSOAdminClient,
} from '@aws-sdk/client-sso-admin';
import { collect, errorCode, isAccessDenied, resource, type Collector } from '../context.ts';

/**
 * AWS Organizations : organisation, racine, OU (récursif), comptes, politiques (SCP, RCP, tags…)
 * et administrateurs délégués. Lisible depuis le compte de gestion ou un administrateur délégué ;
 * depuis un compte membre, seule l'organisation est décrite (`_scope: 'membre'`), sans erreur de scan.
 */
export const organizationsCollector: Collector = {
  service: 'organizations',
  global: true,
  async collect(ctx) {
    const client = new OrganizationsClient(ctx.clientConfig);
    let org;
    try {
      org = (
        await ctx.tryCall('organizations:DescribeOrganization', () =>
          client.send(new DescribeOrganizationCommand({})),
        )
      )?.Organization;
    } catch (err) {
      if (errorCode(err) === 'AWSOrganizationsNotInUseException') return;
      throw err;
    }
    if (!org?.Id) return;

    let roots;
    try {
      roots = (await collect(paginateListRoots({ client }, {}))).flatMap((p) => p.Roots ?? []);
    } catch (err) {
      if (!isAccessDenied(err) || org.MasterAccountId === ctx.accountId) throw err;
      // Compte membre : situation normale, signalée dans la vue Organisation et non comme une erreur de scan.
      ctx.emit(
        resource('AWS::Organizations::Organization', org.Id, ctx.region, { ...org, _scope: 'membre' }),
      );
      return;
    }
    ctx.emit(resource('AWS::Organizations::Organization', org.Id, ctx.region, org, { arn: org.Arn }));

    const delegated = new Map<string, string[]>();
    const admins =
      (await ctx.tryCall('organizations:ListDelegatedAdministrators', () =>
        collect(paginateListDelegatedAdministrators({ client }, {})),
      )) ?? [];
    for (const a of admins.flatMap((p) => p.DelegatedAdministrators ?? [])) {
      if (!a.Id) continue;
      const pages = await ctx.tryCall('organizations:ListDelegatedServicesForAccount', () =>
        collect(paginateListDelegatedServicesForAccount({ client }, { AccountId: a.Id })),
      );
      delegated.set(
        a.Id,
        (pages ?? []).flatMap((p) => p.DelegatedServices ?? []).flatMap((d) => d.ServicePrincipal ?? []),
      );
    }

    // ponytail: parcours séquentiel de l'arbre (l'API Organizations est fortement limitée en débit).
    const walk = async (parentId: string): Promise<void> => {
      const accounts = (
        await collect(paginateListAccountsForParent({ client }, { ParentId: parentId }))
      ).flatMap((p) => p.Accounts ?? []);
      for (const a of accounts) {
        if (!a.Id) continue;
        ctx.emit(
          resource(
            'AWS::Organizations::Account',
            a.Id,
            ctx.region,
            { ...a, _parentId: parentId, _delegatedServices: delegated.get(a.Id) ?? [] },
            { arn: a.Arn },
          ),
        );
      }
      const ous = (
        await collect(paginateListOrganizationalUnitsForParent({ client }, { ParentId: parentId }))
      ).flatMap((p) => p.OrganizationalUnits ?? []);
      for (const ou of ous) {
        if (!ou.Id) continue;
        ctx.emit(
          resource(
            'AWS::Organizations::OrganizationalUnit',
            ou.Id,
            ctx.region,
            { ...ou, _parentId: parentId },
            {
              arn: ou.Arn,
            },
          ),
        );
        await walk(ou.Id);
      }
    };

    for (const root of roots) {
      if (!root.Id) continue;
      ctx.emit(resource('AWS::Organizations::Root', root.Id, ctx.region, root, { arn: root.Arn }));
      await walk(root.Id);
    }

    const types = new Set<PolicyType>();
    for (const root of roots)
      for (const t of root.PolicyTypes ?? []) if (t.Status === 'ENABLED' && t.Type) types.add(t.Type);
    for (const type of types) {
      const policies = (await collect(paginateListPolicies({ client }, { Filter: type }))).flatMap(
        (p) => p.Policies ?? [],
      );
      for (const p of policies) {
        if (!p.Id) continue;
        const described = await ctx.tryCall('organizations:DescribePolicy', () =>
          client.send(new DescribePolicyCommand({ PolicyId: p.Id })),
        );
        const targets = await ctx.tryCall('organizations:ListTargetsForPolicy', () =>
          collect(paginateListTargetsForPolicy({ client }, { PolicyId: p.Id })),
        );
        ctx.emit(
          resource(
            'AWS::Organizations::Policy',
            p.Id,
            ctx.region,
            {
              ...p,
              Content: described?.Policy?.Content,
              _targets: (targets ?? []).flatMap((t) => t.Targets ?? []),
            },
            { arn: p.Arn },
          ),
        );
      }
    }
  },
};

/**
 * IAM Identity Center : instances, permission sets, affectations aux comptes, groupes (avec le seul
 * nombre de membres) et utilisateurs à affectation directe (nom uniquement, aucune autre donnée).
 */
export const identityCenterCollector: Collector = {
  service: 'identitycenter',
  async collect(ctx) {
    const sso = new SSOAdminClient(ctx.clientConfig);
    const ids = new IdentitystoreClient(ctx.clientConfig);
    const instances = (await collect(paginateListInstances({ client: sso }, {}))).flatMap(
      (p) => p.Instances ?? [],
    );
    for (const inst of instances) {
      const InstanceArn = inst.InstanceArn;
      const IdentityStoreId = inst.IdentityStoreId;
      if (!InstanceArn || !IdentityStoreId) continue;
      ctx.emit(resource('AWS::SSO::Instance', InstanceArn, ctx.region, inst, { arn: InstanceArn }));

      const arns = (await collect(paginateListPermissionSets({ client: sso }, { InstanceArn }))).flatMap(
        (p) => p.PermissionSets ?? [],
      );
      const users = new Set<string>();
      for (const PermissionSetArn of arns) {
        const ps = (await sso.send(new DescribePermissionSetCommand({ InstanceArn, PermissionSetArn })))
          .PermissionSet;
        const managed = await ctx.tryCall('sso:ListManagedPoliciesInPermissionSet', () =>
          collect(
            paginateListManagedPoliciesInPermissionSet({ client: sso }, { InstanceArn, PermissionSetArn }),
          ),
        );
        const accounts = (
          await collect(
            paginateListAccountsForProvisionedPermissionSet(
              { client: sso },
              { InstanceArn, PermissionSetArn },
            ),
          )
        ).flatMap((p) => p.AccountIds ?? []);
        ctx.emit(
          resource(
            'AWS::SSO::PermissionSet',
            PermissionSetArn,
            ctx.region,
            {
              ...ps,
              _managedPolicies: (managed ?? []).flatMap((p) => p.AttachedManagedPolicies ?? []),
              _accounts: accounts,
            },
            { arn: PermissionSetArn },
          ),
        );
        for (const AccountId of accounts) {
          const assignments = (
            await collect(
              paginateListAccountAssignments({ client: sso }, { InstanceArn, AccountId, PermissionSetArn }),
            )
          ).flatMap((p) => p.AccountAssignments ?? []);
          for (const a of assignments) {
            if (!a.PrincipalId || !a.PrincipalType) continue;
            if (a.PrincipalType === 'USER') users.add(a.PrincipalId);
            ctx.emit(
              resource(
                'AWS::SSO::AccountAssignment',
                `${AccountId}|${PermissionSetArn}|${a.PrincipalType}|${a.PrincipalId}`,
                ctx.region,
                { ...a, _permissionSetName: ps?.Name },
              ),
            );
          }
        }
      }

      const groups = (await collect(paginateListGroups({ client: ids }, { IdentityStoreId }))).flatMap(
        (p) => p.Groups ?? [],
      );
      for (const g of groups) {
        if (!g.GroupId) continue;
        const GroupId = g.GroupId;
        const members = await ctx.tryCall('identitystore:ListGroupMemberships', () =>
          collect(paginateListGroupMemberships({ client: ids }, { IdentityStoreId, GroupId })),
        );
        ctx.emit(
          resource('AWS::IdentityStore::Group', GroupId, ctx.region, {
            GroupId,
            DisplayName: g.DisplayName,
            Description: g.Description,
            IdentityStoreId,
            ...(members ? { _memberCount: members.flatMap((p) => p.GroupMemberships ?? []).length } : {}),
          }),
        );
      }
      for (const UserId of users) {
        const u = await ctx.tryCall('identitystore:DescribeUser', () =>
          ids.send(new DescribeUserCommand({ IdentityStoreId, UserId })),
        );
        ctx.emit(
          resource('AWS::IdentityStore::User', UserId, ctx.region, {
            UserId,
            UserName: u?.UserName,
            DisplayName: u?.DisplayName,
            IdentityStoreId,
          }),
        );
      }
    }
  },
};
