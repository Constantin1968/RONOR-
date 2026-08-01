# Release Checklist

## Pre-Release

- [ ] All CI checks pass on main
- [ ] CHANGELOG.md updated with release notes
- [ ] Version bumped in package.json
- [ ] No critical or high npm audit findings
- [ ] No verified secrets in codebase
- [ ] All 43+ tests pass
- [ ] Docker build succeeds
- [ ] Local smoke test passes (health endpoint, decision loop, audit verify)

## Release

- [ ] Create release tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
- [ ] Push tag: `git push origin vX.Y.Z`
- [ ] Verify release workflow completes
- [ ] Download and verify checksums
- [ ] Update RELEASE_MANIFEST.md

## Post-Release

- [ ] Verify deployed instance health
- [ ] Run integration test against deployed instance
- [ ] Update documentation if needed
- [ ] Notify stakeholders
- [ ] Archive release artifacts to CIDA

## Rollback (if needed)

1. Identify the issue
2. Revert to previous tag: `git checkout vX.Y.(Z-1)`
3. Deploy previous version
4. Document incident
5. Create hotfix branch if needed
