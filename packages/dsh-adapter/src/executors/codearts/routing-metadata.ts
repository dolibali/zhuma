/** A passive declaration of this adapter's existing route strategy. It is
 * neither a vendor/model catalogue nor a backend/authentication health fact. */
const capability = Object.freeze({
  id: 'provider-default',
  name: '继承码道当前配置（开始时解析）',
  kind: 'adapter-routing-capability',
  backendVerified: false,
} as const);

/** Pure metadata only: no IO, process, configuration lookup or probe. A may
 * project this only for its original prepared, current fixed profile. */
export function describeCodeArtsRoutingCapability() {
  return capability;
}
