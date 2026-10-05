import type { Me, WorkspaceRef } from '../types';
import { isAdminRole } from '../lib/adminLogic';
import { AccountSection } from './settings/Account';
import { AuditSection } from './settings/Audit';
import { MembersSection } from './settings/Members';
import { TokensSection } from './settings/Tokens';

const TITLES: Record<string, string> = { members: 'Members & access', tokens: 'API tokens', audit: 'Audit log', account: 'Account' };

export function SettingsPage(p: { ws: WorkspaceRef; me: Me; section: string }) {
  const admin = isAdminRole(p.ws.role);
  const known = p.section in TITLES;
  return (
    <div className="content">
      <div className="settings-wrap">
        <h1 style={{ marginTop: 0 }}>{TITLES[p.section] ?? 'Settings'}</h1>
        {!known && <div className="empty">Unknown settings section.</div>}
        {known && p.section !== 'account' && !admin && (
          <div className="banner warn" role="alert"><strong>You need admin access</strong> to view this page. Ask a workspace admin or owner if you need changes.</div>
        )}
        {p.section === 'account' && <AccountSection me={p.me} />}
        {admin && p.section === 'members' && <MembersSection ws={p.ws} me={p.me} />}
        {admin && p.section === 'tokens' && <TokensSection ws={p.ws} />}
        {admin && p.section === 'audit' && <AuditSection ws={p.ws} />}
      </div>
    </div>
  );
}
