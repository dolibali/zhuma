import { applyIdentity } from '../../dist/identity-session.js';
import {
  configureDeploymentMode,
  deploymentMode,
  identityAccessMode,
  memberResolver,
  resolveMember,
} from '../../dist/member-session.js';
import { applySpaceDirectory, spaceDirectoryFor } from '../../dist/space-directory.js';
import type {
  ApplyIdentity,
  ApplySpaceDirectory,
  ConfigureDeploymentMode,
  CreateMemberResolver,
  IdentityAccessModeFn,
  ReadDeploymentMode,
  ResolveMember,
  SpaceDirectoryFor,
} from '../../dist/s1-integration.js';

type Assignable<A, B> = [A] extends [B] ? true : false;
type Both<A, B> =
  Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;
type Assert<T extends true> = T;

export const resolveMemberMatches = resolveMember satisfies ResolveMember;
export const memberResolverMatches = memberResolver satisfies CreateMemberResolver;
export const accessModeMatches = identityAccessMode satisfies IdentityAccessModeFn;
export const configureModeMatches = configureDeploymentMode satisfies ConfigureDeploymentMode;
export const readModeMatches = deploymentMode satisfies ReadDeploymentMode;
export const applyIdentityMatches = applyIdentity satisfies ApplyIdentity;
export const applySpaceDirectoryMatches = applySpaceDirectory satisfies ApplySpaceDirectory;
export const spaceDirectoryForMatches = spaceDirectoryFor satisfies SpaceDirectoryFor;

export type ResolveMemberBoth = Assert<Both<typeof resolveMember, ResolveMember>>;
export type MemberResolverBoth = Assert<Both<typeof memberResolver, CreateMemberResolver>>;
export type AccessModeBoth = Assert<Both<typeof identityAccessMode, IdentityAccessModeFn>>;
export type ConfigureDeploymentModeBoth = Assert<
  Both<typeof configureDeploymentMode, ConfigureDeploymentMode>
>;
export type ReadDeploymentModeBoth = Assert<Both<typeof deploymentMode, ReadDeploymentMode>>;
export type ApplyIdentityBoth = Assert<Both<typeof applyIdentity, ApplyIdentity>>;
export type ApplySpaceDirectoryBoth = Assert<Both<typeof applySpaceDirectory, ApplySpaceDirectory>>;
export type SpaceDirectoryForBoth = Assert<Both<typeof spaceDirectoryFor, SpaceDirectoryFor>>;
