# Branch Protection Recommendations

## Main Branch (`main`)

These settings should be configured manually in GitHub repository Settings > Branches > Branch protection rules.

### Recommended Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Require pull request before merging | Yes | All changes reviewed before merge |
| Required approvals | 1 | CODEOWNERS review |
| Dismiss stale reviews | Yes | Re-review after new commits |
| Require status checks to pass | Yes | CI must pass |
| Required status checks | `build`, `test`, `security` | All three CI jobs |
| Require branches to be up to date | Yes | No stale merges |
| Require signed commits | No (future) | Enable when GPG keys configured |
| Include administrators | Yes | No bypass |
| Allow force pushes | Never | History integrity |
| Allow deletions | No | Branch preservation |

### Merge Strategy

| Policy | Setting |
|--------|---------|
| Allow merge commits | Yes |
| Allow squash merging | No |
| Allow rebase merging | No |
| Automatically delete head branches | Yes |

### Setup Instructions

1. Navigate to: Settings > Branches > Add branch protection rule
2. Branch name pattern: `main`
3. Apply settings from table above
4. Save changes

## Feature Branches

No protection rules required. Feature branches are developer-owned and deleted after merge.

## Release Tags

Tags matching `v*` trigger the release verification workflow automatically. Tags should not be deleted or moved after creation.
