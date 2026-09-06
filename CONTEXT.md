# Agent Pages

Agent Pages lets owners and their coding agents publish and maintain static websites. Visitors view the published content according to the site's access policy.

## Language

**Site**:
A named collection of static files with a stable identity and a visitor URL. Updating its content preserves that identity.
_Avoid_: Page when referring to the entire site, project, app

**Site file**:
A document or asset addressed by a path inside one site. A site can contain multiple pages and shared assets.
_Avoid_: Page when referring to an arbitrary asset

**Revision**:
A complete, internally consistent set of a site's files at one point in its history.
_Avoid_: Version when referring to an application release

**Active revision**:
The revision currently selected for visitors to a site.
_Avoid_: Latest revision, because a prepared revision may not be published

**Publication**:
The operation that makes a complete revision active at the site's existing visitor URL.
_Avoid_: Deployment when referring to publication of site content

**Owner**:
The authenticated person who created a site, directly or through an agent acting on their behalf. Only the owner can manage the site and view it while it is private.
_Avoid_: Uploader when referring to a different person updating an existing site

**Operator**:
The person responsible for running the installation and provisioning access. Operating the installation does not grant an application-level right to browse another owner's private sites.
_Avoid_: Owner when referring to installation administration

**Visitor**:
A person viewing a site's published content. Permission to view a site does not grant permission to manage it.
_Avoid_: User when the viewing role matters

**Private site**:
A site whose pages and assets are visible only to its authenticated owner. Every newly created site is private.
_Avoid_: Unlisted site, private URL, password-shared site

**Public site**:
A site whose owner has explicitly allowed anyone to view its pages and assets. Public visibility grants no management rights.
_Avoid_: Published site as a synonym, because a private site also has an active revision

**Expired site**:
A site whose publication lifetime has ended and whose content is no longer available to visitors, even if physical cleanup is pending.
_Avoid_: Deleted site before cleanup has completed

**Owner expiration default**:
The owner's preset lifetime for new sites whose creation input omits expiration. Changing it does not affect existing sites.
_Avoid_: Global expiration, because the setting is stored per owner

**Site expiration**:
The time when one site's publication lifetime ends. A live site's owner can extend, shorten or remove it; an expired site cannot be revived.
_Avoid_: Retention period, because operation receipts and stored content have separate retention rules
