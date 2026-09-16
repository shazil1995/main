"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Contact, CurrentUser, createContact, fetchContacts, fetchMe, logout } from "../../lib/api";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [creating, setCreating] = useState(false);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const me = await fetchMe();
      setUser(me);
      const contactList = await fetchContacts();
      setContacts(contactList);
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  async function handleCreateContact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await createContact({
        firstName: formState.firstName,
        lastName: formState.lastName,
        email: formState.email || undefined,
        phone: formState.phone || undefined,
      });
      setFormState({ firstName: "", lastName: "", email: "", phone: "" });
      const contactList = await fetchContacts();
      setContacts(contactList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create contact");
    } finally {
      setCreating(false);
    }
  }

  const canWriteContacts = user?.permissions.includes("contacts:write") ?? false;

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Signage CRM</h1>
          {user ? (
            <p className="text-sm text-slate-500" data-testid="current-user">
              {user.firstName} {user.lastName} · {user.roles.join(", ")}
            </p>
          ) : null}
        </div>
        <button
          onClick={handleLogout}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Sign out
        </button>
      </header>

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      {canWriteContacts ? (
        <form
          onSubmit={handleCreateContact}
          className="mb-8 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-5"
        >
          <input
            required
            placeholder="First name"
            value={formState.firstName}
            onChange={(event) => setFormState((s) => ({ ...s, firstName: event.target.value }))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            required
            placeholder="Last name"
            value={formState.lastName}
            onChange={(event) => setFormState((s) => ({ ...s, lastName: event.target.value }))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            placeholder="Email"
            value={formState.email}
            onChange={(event) => setFormState((s) => ({ ...s, email: event.target.value }))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            placeholder="Phone"
            value={formState.phone}
            onChange={(event) => setFormState((s) => ({ ...s, phone: event.target.value }))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {creating ? "Adding…" : "Add contact"}
          </button>
        </form>
      ) : (
        <p className="mb-8 text-sm text-slate-500">Your role does not have permission to add contacts.</p>
      )}

      <div className="rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm" data-testid="contacts-table">
          <thead className="border-b border-slate-200 text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Phone</th>
              <th className="px-4 py-2">Company</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr key={contact.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2">
                  {contact.firstName} {contact.lastName}
                </td>
                <td className="px-4 py-2">{contact.emails[0]?.email ?? "—"}</td>
                <td className="px-4 py-2">{contact.phones[0]?.phone ?? "—"}</td>
                <td className="px-4 py-2">{contact.company?.name ?? "—"}</td>
              </tr>
            ))}
            {contacts.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  No contacts yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}
