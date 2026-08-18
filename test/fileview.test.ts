import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { EventEmitter, invoked, resetFake, TextDocument, Uri, window, workspace } from "./fakevscode";
import { FileCommentsView } from "../src/fileview";
import { SharingState } from "../src/sharing";
import { LiveRanges } from "../src/live";
import { AnnotationStore } from "../src/store";

let root = "";
let closing: Array<{ dispose(): void }> = [];
let answers: Record<string, number | undefined> = { "rev-parse": 128 };

interface Posted {
  type: string;
  key: string;
  head: string;
  note: string;
  cards: Array<{ id: string; html: string; line: string }>;
}

function fakeView() {
  const posted: Posted[] = [];
  const received = new EventEmitter<unknown>();
  const visibility = new EventEmitter<void>();
  const closed = new EventEmitter<void>();
  const webview = {
    options: undefined as unknown,
    html: "",
    cspSource: "vscode-webview://cspsource",
    onDidReceiveMessage: received.event,
    postMessage(message: Posted) {
      posted.push(message);
      return Promise.resolve(true);
    }
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: visibility.event,
    onDidDispose: closed.event
  };
  return { view, webview, posted, received, visibility, closed };
}

function writeStore(annotations: unknown[]): void {
  fs.mkdirSync(nodePath.join(root, ".vscode"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, ".vscode", "codelight.json"),
    JSON.stringify({ version: 1, annotations }, null, 2)
  );
}

function annotation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    file: "a.ts",
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments: [
      {
        id: "c1",
        author: { login: "ada", id: "42" },
        body: "worth a look",
        createdAt: "2026-08-17T09:12:33.000Z",
        updatedAt: "2026-08-17T09:12:33.000Z"
      }
    ],
    ...overrides
  };
}

function hostile(): Record<string, unknown> {
  return annotation({
    anchor: { text: "<img src=x onerror=alert(1)>", before: "", after: "" },
    comments: [
      {
        id: "c1",
        author: { login: "<script>alert('login')</script>", id: "9" },
        body: '</div><img src=x onerror=alert(2)><div class="body">',
        createdAt: "2026-08-17T09:12:33.000Z",
        updatedAt: "2026-08-17T09:12:33.000Z"
      }
    ]
  });
}

async function mount(
  annotations: unknown[],
  body = "const hello = 1;\n"
): Promise<{
  store: AnnotationStore;
  view: FileCommentsView;
  fake: ReturnType<typeof fakeView>;
  document: TextDocument;
}> {
  writeStore(annotations);
  const store = new AnnotationStore();
  await store.initialize();
  const live = new LiveRanges(store);
  const shares = new SharingState((args) =>
    Promise.resolve(args[0] in answers ? answers[args[0]] : 1)
  );
  const view = new FileCommentsView(store, live, shares);
  closing.push(store, live, view);
  const document = new TextDocument(Uri.file(nodePath.join(root, "a.ts")), body);
  workspace.textDocuments = [document];
  const editor = { document };
  (window as { activeTextEditor: unknown }).activeTextEditor = editor;
  window.visibleTextEditors = [editor as never];
  const fake = fakeView();
  view.resolveWebviewView(fake.view as never);
  view.ready();
  return { store, view, fake, document };
}

function latest(fake: ReturnType<typeof fakeView>): Posted {
  const last = fake.posted[fake.posted.length - 1];
  assert.ok(last, "expected the view to post something");
  return last;
}

beforeEach(() => {
  resetFake();
  closing = [];
  answers = { "rev-parse": 128 };
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-fileview-"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "repo", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the cards the file view posts", () => {
  it("shows the snippet, the author and the comment", async () => {
    const { fake } = await mount([annotation()]);
    const posted = latest(fake);
    assert.equal(posted.type, "cards");
    assert.equal(posted.cards.length, 1);
    assert.ok(posted.head.includes("a.ts"));
    assert.ok(posted.cards[0].html.includes("const"));
    assert.ok(posted.cards[0].html.includes("@ada"));
    assert.ok(posted.cards[0].html.includes("worth a look"));
    assert.equal(posted.cards[0].id, "a1");
  });

  it("leaves out a highlight that carries no comment", async () => {
    const { fake } = await mount([annotation({ comments: [] })]);
    const posted = latest(fake);
    assert.deepEqual(posted.cards, []);
    assert.ok(posted.note.includes("No comments in this file"));
  });

  it("says so when the project has no notes at all", async () => {
    const { fake } = await mount([]);
    assert.ok(latest(fake).note.includes("showing no annotations"));
  });

  it("marks a stranded highlight rather than dropping it", async () => {
    const { fake } = await mount([annotation({ orphaned: true })]);
    const posted = latest(fake);
    assert.equal(posted.cards.length, 1);
    assert.ok(posted.cards[0].html.includes("orphan"));
    assert.equal(posted.cards[0].line, "text deleted");
  });
});

describe("what the file view says about git", () => {
  it("says nothing at all until git answers", async () => {
    answers = { "rev-parse": undefined };
    const { fake } = await mount([annotation()]);
    assert.equal(latest(fake).head.includes("machine"), false);
    assert.equal(latest(fake).head.includes("repository"), false);
  });

  it("says the notes stay here when git ignores them", async () => {
    answers = { "rev-parse": 0, "check-ignore": 0 };
    const { fake } = await mount([annotation()]);
    for (let attempt = 0; attempt < 40 && !latest(fake).head.includes("machine"); attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.ok(latest(fake).head.includes("stay on this machine"), latest(fake).head);
  });

  it("says the notes travel once they are committed", async () => {
    answers = { "rev-parse": 0, "check-ignore": 1, "ls-files": 0 };
    const { fake } = await mount([annotation()]);
    for (let attempt = 0; attempt < 40 && !latest(fake).head.includes("repository"); attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.ok(latest(fake).head.includes("travel with the repository"), latest(fake).head);
  });

  it("says nobody else has them while they are uncommitted", async () => {
    answers = { "rev-parse": 0, "check-ignore": 1, "ls-files": 1 };
    const { fake } = await mount([annotation()]);
    for (let attempt = 0; attempt < 40 && !latest(fake).head.includes("committed"); attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.ok(latest(fake).head.includes("not committed"), latest(fake).head);
  });
});

describe("what the file view does with a hostile annotation", () => {
  it("encodes every angle bracket and quote it renders", async () => {
    const { fake } = await mount([hostile()]);
    const html = latest(fake).cards[0].html;
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes('class="body">'), true);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(html.includes("&lt;script&gt;alert(&#39;login&#39;)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;/div&gt;&lt;img src=x onerror=alert(2)&gt;"));
    assert.ok(html.includes("&quot;body&quot;"));
  });

  it("counts the tags it opens so the markup cannot be escaped", async () => {
    const { fake } = await mount([hostile()]);
    const html = latest(fake).cards[0].html;
    const opened = (html.match(/<div/g) ?? []).length + (html.match(/<span/g) ?? []).length;
    const closed = (html.match(/<\/div>/g) ?? []).length + (html.match(/<\/span>/g) ?? []).length;
    assert.equal(opened, closed);
  });

  it("keeps a colour it did not write out of the style attribute", async () => {
    const { fake } = await mount([annotation({ color: 'yellow" onload="alert(1)' })]);
    const html = latest(fake).cards[0].html;
    assert.equal(html.includes("onload="), false);
  });
});

describe("the shell the file view builds", () => {
  it("allows no source but its own script and styles", async () => {
    const { fake } = await mount([annotation()]);
    const policy = /content="([^"]+)"/.exec(fake.webview.html)?.[1];
    assert.ok(policy, "expected a content security policy");
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(policy.includes("script-src 'nonce-"));
    assert.equal(/script-src[^;]*unsafe-inline/.test(policy), false);
    assert.equal(/default-src[^;]*unsafe-inline/.test(policy), false);
    assert.deepEqual((fake.webview.options as { localResourceRoots: unknown[] }).localResourceRoots, []);
  });

  it("gives every mount its own nonce", async () => {
    const { fake } = await mount([annotation()]);
    const first = /nonce-([A-Za-z0-9+/=]+)/.exec(fake.webview.html)?.[1];
    const second = fakeView();
    closing[closing.length - 1] = closing[closing.length - 1];
    const view = closing[closing.length - 1] as FileCommentsView;
    view.resolveWebviewView(second.view as never);
    const again = /nonce-([A-Za-z0-9+/=]+)/.exec(second.webview.html)?.[1];
    assert.ok(first);
    assert.ok(again);
    assert.notEqual(first, again);
  });
});

describe("what the file view accepts back", () => {
  it("reveals only when the message is shaped like a reveal", async () => {
    const { fake } = await mount([annotation()]);
    const at = invoked.length;
    fake.received.fire("reveal");
    fake.received.fire({ type: "reveal" });
    fake.received.fire({ type: "nonsense", id: "a1" });
    fake.received.fire({ type: "reveal", id: 7 });
    assert.deepEqual(invoked.slice(at), []);
    fake.received.fire({ type: "reveal", id: "a1" });
    assert.deepEqual(invoked.slice(at), [["codelight.revealAnnotation", "a1"]]);
  });

  it("hands an unknown id straight through for the panel to refuse", async () => {
    const { fake } = await mount([annotation()]);
    const at = invoked.length;
    fake.received.fire({ type: "reveal", id: "not-a-real-id" });
    assert.deepEqual(invoked.slice(at), [["codelight.revealAnnotation", "not-a-real-id"]]);
  });
});
