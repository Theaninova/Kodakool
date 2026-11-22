import { describe, expect, it } from "vitest";
import { openMemoryDb } from "./db-node.ts";
import { userByOidc } from "./db.ts";
import { upsertOidcUser } from "./oidc.ts";

const ISS = "https://id.example";
const PW_ID = "pw-user";

function withPasswordUser(email: string) {
  const db = openMemoryDb();
  db.prepare("INSERT INTO users (id, email, name, pass, created) VALUES (?, ?, ?, 'scrypt$x', ?)").run(
    PW_ID,
    email,
    "Password Ann",
    Date.now(),
  );
  return db;
}

describe("upsertOidcUser email collision", () => {
  it("links a VERIFIED email onto the existing password account", () => {
    const db = withPasswordUser("ann@example.org");
    const user = upsertOidcUser(db, ISS, { sub: "sub-1", email: "ann@example.org", email_verified: true });
    expect(user.id).toBe(PW_ID);
    expect(user.oidc_iss).toBe(ISS);
    expect(userByOidc(db, ISS, "sub-1")?.id).toBe(PW_ID);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("keeps the login working with a NULL email when the address is unverified", () => {
    const db = withPasswordUser("ann@example.org");
    const user = upsertOidcUser(db, ISS, { sub: "sub-2", email: "ann@example.org", email_verified: false });
    expect(user.id).not.toBe(PW_ID);
    expect(user.email).toBeNull();
    // the password account is untouched
    expect(userByOidc(db, ISS, "sub-1")).toBeNull();
    expect(db.prepare("SELECT pass, oidc_iss FROM users WHERE id = ?").get(PW_ID)).toEqual({
      pass: "scrypt$x",
      oidc_iss: null,
    });
  });

  it("unverified collisions never throw — and many such users coexist", () => {
    const db = withPasswordUser("ann@example.org");
    upsertOidcUser(db, ISS, { sub: "sub-3", email: "ann@example.org" }); // email_verified missing
    const other = upsertOidcUser(db, ISS, { sub: "sub-4", email: "ann@example.org" });
    expect(other.email).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 3 });
  });

  it("inserts normally when the email is free", () => {
    const db = openMemoryDb();
    const user = upsertOidcUser(db, ISS, { sub: "sub-5", email: "fresh@example.org", email_verified: true });
    expect(user.email).toBe("fresh@example.org");
    expect(userByOidc(db, ISS, "sub-5")?.id).toBe(user.id);
  });
});
