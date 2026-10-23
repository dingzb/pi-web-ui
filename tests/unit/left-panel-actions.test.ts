// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { joinProjectPath, isValidProjectName, parentOf, MACHINE_ROOT } from "../../web/src/components/ProjectPicker.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { getContextMenu, closeContextMenu } from "../../web/src/context-menu-state.js";

let root: Root | null = null;

/** 内存 localStorage：某些 jsdom/CI 环境的存储不可写，桩掉以保证语言确定为中文。 */
function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(overrides: Record<string, unknown> = {}) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	const panelSend = (msg: unknown) => {
		sent.push(msg);
		return true;
	};
	const props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [
			{
				path: "session-1.jsonl",
				name: "Test Session",
				firstMessage: "Hello",
				modified: Date.now(),
				messageCount: 1,
			},
		],
		projects: [{ path: "/test", lastUsed: Date.now() }],
		activeConversationId: "",
		panelSend,
		pathCompletions: [
			{ name: "sub1", path: "/test/sub1", type: "dir" as const },
			{ name: "sub2", path: "/test/sub2", type: "dir" as const },
			{ name: "file.txt", path: "/test/file.txt", type: "file" as const },
		],
		...overrides,
	};
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, props),
			),
		);
	});
	return {
		container,
		sent,
		rerender: (updates: Record<string, unknown>) => {
			Object.assign(props, updates);
			act(() => root!.render(createElement(LanguageProvider, null, createElement(LeftPanel as any, props))));
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	closeContextMenu();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("LeftPanel 标题栏操作与项目管理", () => {
	it("projects=[] 时仍渲染“最近项目”标题栏和项目管理按钮，且不渲染项目滚动区", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		// 标题栏存在
		const projectsSection = container.querySelector(".panel-projects");
		expect(projectsSection).toBeTruthy();
		expect(projectsSection?.textContent).toContain("项目");

		// 项目管理按钮存在
		const projectActionBtn = container.querySelector(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		// 空项目区不渲染 .projects-scroll
		expect(container.querySelector(".projects-scroll")).toBeNull();
	});

	it("合并的项目标题栏渲染新对话加号按钮，点击后发送 new_chat 且不影响折叠状态", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel();

		const newChatBtn = container.querySelector<HTMLButtonElement>(".lp-new-chat-action");
		expect(newChatBtn).toBeTruthy();
		expect(newChatBtn?.title).toBeTruthy();
		expect(newChatBtn?.getAttribute("aria-label")).toBeTruthy();

		const sessionsSection = container.querySelector(".panel-projects");
		const wasCollapsed = sessionsSection?.classList.contains("collapsed");

		// 点击加号
		sent.length = 0;
		act(() => newChatBtn!.click());
		expect(sent).toEqual([{ type: "new_chat" }]);
		expect(sessionsSection?.classList.contains("collapsed")).toBe(wasCollapsed);
	});

	it("标题行容器与折叠按钮不产生嵌套 button（无 button button）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		// 保证没有嵌套按钮
		const nestedButtons = container.querySelectorAll("button button");
		expect(nestedButtons.length).toBe(0);
	});

	it("点击项目管理按钮打开项目管理面板，点击遮罩或按 Escape 键可关闭", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		// 点击打开项目管理面板（弹层 Portal 到 body，故用 document 查）
		act(() => projectActionBtn!.click());
		const dialog = document.querySelector("[role=dialog]");
		expect(dialog).toBeTruthy();

		// 按 Escape 键关闭
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(document.querySelector("[role=dialog]")).toBeNull();

		// 再次打开并点击遮罩关闭
		act(() => projectActionBtn!.click());
		expect(document.querySelector("[role=dialog]")).toBeTruthy();
		const backdrop = document.querySelector(".status-cwd-backdrop, .project-picker-backdrop");
		expect(backdrop).toBeTruthy();
		act(() => (backdrop as HTMLElement).click());
		expect(document.querySelector("[role=dialog]")).toBeNull();
	});

	it("项目管理面板：非法项目名称（空或含分隔符）不能发送创建消息，合法名称发送 make_dir(setAsCwd: true)", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());

		expect(document.querySelector(".project-picker")?.parentElement).toBe(document.body);

		// 展开新建项目输入框
		const newBtn = document.querySelector<HTMLButtonElement>(".cwd-newbtn, .project-picker-newbtn");
		expect(newBtn).toBeTruthy();
		act(() => newBtn!.click());

		const input = document.querySelector<HTMLInputElement>(".cwd-newrow input, .project-picker-newrow input");
		expect(input).toBeTruthy();
		const createBtn = document.querySelector<HTMLButtonElement>(
			".cwd-newrow button.primary, .project-picker-newrow button.primary",
		);
		expect(createBtn).toBeTruthy();

		// 空名称点击
		sent.length = 0;
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		// 包含路径分隔符
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "foo/bar");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		// 合法名称
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "my-new-project");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		const makeDirMsg = sent.find((m: any) => m.type === "make_dir") as any;
		expect(makeDirMsg).toBeTruthy();
		expect(makeDirMsg.setAsCwd).toBe(true);
		expect(makeDirMsg.path).toContain("my-new-project");
	});

	it("项目管理面板：选择现有目录发送 set_cwd", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());

		const chooseBtns = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".cwd-choose-btn, .project-picker-choose-btn"),
		);
		expect(chooseBtns.length).toBeGreaterThan(0);

		sent.length = 0;
		act(() => chooseBtns[0].click());
		const setCwdMsg = sent.find((m: any) => m.type === "set_cwd") as any;
		expect(setCwdMsg).toBeTruthy();
		expect(setCwdMsg.path).toBeTruthy();
	});

	it("joinProjectPath 纯函数正确处理 POSIX 和 Windows 根与路径拼接", () => {
		expect(joinProjectPath("/", "foo")).toBe("/foo");
		expect(joinProjectPath("/a", "b")).toBe("/a/b");
		expect(joinProjectPath("/a/", "b")).toBe("/a/b");
		expect(joinProjectPath("C:", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:/", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:\\dir", "sub")).toBe("C:/dir/sub");
	});

	it("isValidProjectName 校验项目名称合法性", () => {
		expect(isValidProjectName("my-project")).toBe(true);
		expect(isValidProjectName("  my-project  ")).toBe(true);
		expect(isValidProjectName("")).toBe(false);
		expect(isValidProjectName("   ")).toBe(false);
		expect(isValidProjectName(".")).toBe(false);
		expect(isValidProjectName("..")).toBe(false);
		expect(isValidProjectName("foo/bar")).toBe(false);
		expect(isValidProjectName("foo\\bar")).toBe(false);
	});

	it("parentOf 返回父路径或在根处返回 null", () => {
		expect(parentOf("/")).toBeNull();
		expect(parentOf(MACHINE_ROOT)).toBeNull();
		expect(parentOf("/a")).toBe("/");
		expect(parentOf("/a/b")).toBe("/a");
		expect(parentOf("/a/b/")).toBe("/a");
		expect(parentOf("C:")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/Users")).toBe("C:/");
		expect(parentOf("C:/Users/test")).toBe("C:/Users");
	});
});

describe("LeftPanel 会话行内嵌区", () => {
	const pluginEntry = () => ({
		id: "plug:x:go",
		source: "plugin:x",
		slot: "leftpanel.sessions",
		label: "Go",
		kind: "action",
		order: 100,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});

	it("插件行动作渲染在会话行尾（leftpanel.sessions 里的条目都进行内嵌区）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiLeftSessions: [pluginEntry()] });
		const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".lp-slot-btn"));
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("Go");
	});

	it("内嵌区为空时不留 .lp-slot-sessions 占位（会话行 DOM 与旧版一致）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiLeftSessions: [] });
		expect(container.querySelector(".lp-slot-sessions")).toBeNull();
		expect(container.querySelector(".lp-slot-btn")).toBeNull();
	});
});

describe("LeftPanel P1：分区标题栏 / 项目行 / 项目右键插件位", () => {
	const entry = (slot: string, id: string, label: string) => ({
		id: `plug:x:${id}`,
		source: "plugin:x",
		slot,
		label,
		kind: "action",
		order: 100,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});
	const oneProject = [{ path: "/test/p1", lastUsed: Date.now() }];

	it("合并后的项目标题保留项目与历史插件按钮", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: oneProject,
			conversations: [{ id: "c1", title: "run", cwd: "/test", messageCount: 1, isStreaming: true, isSubagent: false }],
			uiProjectsActions: [entry("leftpanel.projects.actions", "pa", "PA")],
			uiRunningActions: [entry("leftpanel.running.actions", "ra", "RA")],
			uiHistoryActions: [entry("leftpanel.history.actions", "ha", "HA")],
		});
		const pick = (sel: string) => container.querySelector(`${sel} .lp-section-actions .lp-slot-section .lp-slot-btn`);
		expect(pick(".panel-projects")?.getAttribute("aria-label")).toBe("PA");
		expect(pick(".panel-convs")).toBeNull();
		expect(container.querySelector('.panel-projects [aria-label="HA"]')).toBeTruthy();
		// 宿主「管理项目」按钮仍在，插件按钮紧随其后
		const projActions = container.querySelector(".panel-projects .lp-section-actions");
		expect(container.querySelector(".lp-panel > .lp-new-chat-action")).toBeTruthy();
	});

	it("分区标题栏无插件条目时不留占位（标题栏 DOM 与旧版一致）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject });
		expect(container.querySelector(".lp-slot-section")).toBeNull();
		// 运行分区没有宿主按钮：无插件条目时标题栏根本不出 .lp-section-actions
		expect(container.querySelector(".panel-convs")).toBeNull();
	});

	it("项目行内嵌区：点击回传 target={id: 项目路径, kind: project}", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const onUiAction = vi.fn();
		const { container } = mountLeftPanel({
			projects: oneProject,
			uiLeftProject: [entry("leftpanel.project", "pj", "PJ")],
			onUiAction,
		});
		const btn = container.querySelector<HTMLButtonElement>(".lp-row .lp-slot-project .lp-slot-btn");
		expect(btn?.getAttribute("aria-label")).toBe("PJ");
		act(() => btn!.click());
		expect(onUiAction).toHaveBeenCalledTimes(1);
		const [item, value, target] = onUiAction.mock.calls[0]!;
		expect((item as { id: string }).id).toBe("plug:x:pj");
		expect(value).toBeUndefined();
		expect(target).toEqual({ id: "/test/p1", kind: "project", label: "p1" });
	});

	it("项目行无插件条目时不渲染 .lp-slot-project 占位", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject, uiLeftProject: [] });
		expect(container.querySelector(".lp-slot-project")).toBeNull();
	});

	it("右键项目行：有插件条目 → 打开 contextmenu.project（target.kind=project）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: oneProject,
			uiContextProject: [entry("contextmenu.project", "pm", "项目菜单")],
		});
		const row = container.querySelector<HTMLElement>(".lp-row");
		act(() => {
			row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
		});
		const menu = getContextMenu();
		expect(menu?.slot).toBe("contextmenu.project");
		expect(menu?.target).toEqual({ id: "/test/p1", kind: "project", label: "p1" });
		expect(menu?.entries.map((e) => e.label)).toEqual(["项目菜单"]);
	});

	it("项目行右键但没有任何插件条目 → 不抢浏览器右键（不开菜单）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject, uiContextProject: [] });
		const row = container.querySelector<HTMLElement>(".lp-row");
		act(() => {
			row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		});
		expect(getContextMenu()).toBeNull();
	});
});

describe("LeftPanel P2：分区顺序 / 显隐 / 分隔条 / 行内槽位拆分", () => {
	const hostSection = (id: string, hidden = false) => ({
		id,
		source: "host",
		slot: "leftpanel.sections",
		label: id,
		kind: "action",
		order: 10,
		align: "start",
		hidden,
		userOverrides: [],
		arrangedBy: [],
	});
	const oneProject = [{ path: "/test/p1", lastUsed: Date.now() }];
	const runningConv = [{ id: "c1", title: "run", cwd: "/test", messageCount: 1, isStreaming: true, isSubagent: false }];
	/** 分区在 DOM 里的先后（只看直接子节点，分隔条不计入）。 */
	const sectionOrder = (container: HTMLElement) =>
		Array.from(container.querySelectorAll<HTMLElement>(".lp-nav-scroll > .lp-section")).map((el) =>
			el.classList.contains("panel-projects")
				? "projects"
				: el.classList.contains("panel-convs")
					? "convs"
					: el.classList.contains("panel-sessions")
						? "sessions"
						: "?",
		);

	it("uiSections 决定分区先后（布局页调序的结果）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: oneProject,
			conversations: runningConv,
			uiSections: [hostSection("host:lp-history"), hostSection("host:lp-projects"), hostSection("host:lp-running")],
		});
		expect(sectionOrder(container)).toEqual(["projects"]);
	});

	it("隐藏的分区不渲染，分隔条按剩余展开分区重新配对", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const all = mountLeftPanel({ projects: oneProject, conversations: runningConv });
		expect(all.container.querySelectorAll(".lp-sash")).toHaveLength(0);
		all.container.remove();
		act(() => root!.unmount());
		root = null;

		const { container } = mountLeftPanel({
			projects: oneProject,
			conversations: runningConv,
			uiSections: [
				hostSection("host:lp-projects", true),
				hostSection("host:lp-running"),
				hostSection("host:lp-history"),
			],
		});
		expect(sectionOrder(container)).toEqual([]);
		expect(container.querySelectorAll(".lp-sash")).toHaveLength(0);
	});

	it("默认只显示合并的项目对话分区，不显示运行分区与分隔条", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: oneProject, conversations: runningConv });
		expect(sectionOrder(container)).toEqual(["projects"]);
		expect(container.querySelectorAll(".lp-sash")).toHaveLength(0);
	});

	it("项目内运行行与历史行各用自己的行内槽位", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const mk = (slot: string, id: string) => ({
			id: `plug:x:${id}`,
			source: "plugin:x",
			slot,
			label: id,
			kind: "action",
			order: 100,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		});
		const { container } = mountLeftPanel({
			conversations: runningConv,
			uiLeftSessions: [mk("leftpanel.sessions", "s")],
			uiLeftRunning: [mk("leftpanel.running", "r")],
			uiLeftHistory: [mk("leftpanel.history", "h")],
		});
		const labels = (sel: string) =>
			Array.from(container.querySelectorAll<HTMLElement>(`${sel} .lp-slot-sessions .lp-slot-btn`)).map((b) =>
				b.getAttribute("aria-label"),
			);
		expect(labels(".panel-convs")).toEqual([]);
		expect(labels(".lp-project-sessions")).toEqual(["s", "h", "s", "r"]);
	});
});

describe("运行对话并入项目", () => {
	it("合并去重并直接切换运行态，显示流式状态", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent, rerender } = mountLeftPanel({
			conversations: [
				{
					id: "c-live",
					title: "直播消息",
					cwd: "/test",
					sessionFile: "session-1.jsonl",
					messageCount: 4,
					isStreaming: true,
					isSubagent: false,
				},
			],
		});
		expect(container.querySelector(".panel-convs")).toBeNull();
		const rows = container.querySelectorAll<HTMLButtonElement>(".lp-project-sessions .session-item");
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain("直播消息");
		expect(rows[0].querySelector(".spin")).toBeTruthy();
		act(() => rows[0].click());
		expect(sent).toContainEqual({ type: "switch_conversation", id: "c-live" });
		rerender({
			conversations: [
				{
					id: "c-live",
					title: "已完成的最终消息",
					cwd: "/test",
					sessionFile: "session-1.jsonl",
					messageCount: 5,
					isStreaming: false,
					isSubagent: false,
				},
			],
		});
		expect(container.querySelectorAll(".lp-project-sessions .session-item")).toHaveLength(1);
		expect(container.querySelector(".lp-project-sessions")?.textContent).toContain("已完成的最终消息");
		expect(container.querySelector(".lp-project-sessions .spin")).toBeNull();
	});
});

describe("LeftPanel P4：插件自定义分区（kind=view）", () => {
	const hostEntry = (id: string) => ({
		id,
		source: "host",
		slot: "leftpanel.sections",
		label: id,
		kind: "action",
		order: 10,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});
	const pluginSection = (id = "notes:fav", label = "收藏", hidden = false) => ({
		id,
		source: "plugin:notes",
		slot: "leftpanel.sections",
		label,
		kind: "view",
		order: 100,
		align: "start",
		hidden,
		userOverrides: [],
		arrangedBy: [],
	});
	const allSections = (extra: unknown[]) => [
		hostEntry("host:lp-projects"),
		hostEntry("host:lp-running"),
		hostEntry("host:lp-history"),
		...extra,
	];

	it("插件分区：标题是条目 label，正文来自 renderPluginSectionBody", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const render = vi.fn(() => createElement("div", { className: "fake-plugin-body" }, "插件正文"));
		const { container } = mountLeftPanel({
			uiSections: allSections([pluginSection()]),
			renderPluginSectionBody: render,
		});
		const sec = container.querySelector(".lp-section-plugin");
		expect(sec).not.toBeNull();
		expect(sec?.querySelector(".lp-section-title-text")?.textContent).toBe("收藏");
		expect(sec?.querySelector(".fake-plugin-body")?.textContent).toBe("插件正文");
		expect(render).toHaveBeenCalledWith(expect.objectContaining({ id: "notes:fav" }));
	});

	it("点标题折叠：正文消失，折叠态写入 localStorage（只记折叠的分区键）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiSections: allSections([pluginSection()]),
			renderPluginSectionBody: () => createElement("div", { className: "fake-plugin-body" }, "x"),
		});
		const title = container.querySelector<HTMLButtonElement>(".lp-section-plugin .lp-section-title");
		act(() => title!.click());
		expect(container.querySelector(".lp-section-plugin.collapsed")).not.toBeNull();
		expect(container.querySelector(".lp-section-plugin .fake-plugin-body")).toBeNull();
		expect(localStorage.getItem("pi-web-ui:lp-collapse-plugin-sections")).toBe(JSON.stringify(["plugin:notes:fav"]));
	});

	it("没有正文渲染器时分区仍在（正文为空，不抛错）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiSections: allSections([pluginSection("notes:bare", "裸分区")]) });
		const sec = container.querySelector(".lp-section-plugin");
		expect(sec?.querySelector(".lp-section-title-text")?.textContent).toBe("裸分区");
		expect(sec?.querySelector(".lp-plugin-section-body")?.childElementCount).toBe(0);
	});

	it("布局页隐藏的插件分区不渲染", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ uiSections: allSections([pluginSection("notes:fav", "收藏", true)]) });
		expect(container.querySelector(".lp-section-plugin")).toBeNull();
	});
});

describe("按项目分组的历史", () => {
	it("分组显示、独立折叠并直接打开其他项目的对话", () => {
		setAppGlobals({ cwd: "/a", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({
			projects: [
				{ path: "/a", lastUsed: 2 },
				{ path: "/b", lastUsed: 1 },
			],
			sessions: [
				{ path: "a.jsonl", cwd: "/a", name: "A chat", firstMessage: "", messageCount: 1, modified: 2 },
				{ path: "b.jsonl", cwd: "/b", name: "B chat", firstMessage: "", messageCount: 1, modified: 1 },
			],
		});
		const groups = container.querySelectorAll(".lp-project-group");
		expect(groups).toHaveLength(2);
		expect(groups[0].textContent).toContain("A chat");
		expect(groups[0].textContent).not.toContain("B chat");
		sent.length = 0;
		act(() => (groups[1].querySelector(".session-item") as HTMLButtonElement).click());
		expect(sent).toEqual([{ type: "switch_session", path: "b.jsonl" }]);
		act(() => (groups[0].querySelector(".lp-project-toggle") as HTMLButtonElement).click());
		expect(groups[0].querySelector(".session-item")).toBeNull();
		expect(groups[1].querySelector(".session-item")).toBeTruthy();
		expect(container.querySelector(".lp-section-sessions")).toBeNull();
	});
});
