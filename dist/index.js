#!/usr/bin/env node
import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { createOptions } from "knip/session";
import { readFile } from "node:fs/promises";
//#region src/graph/loc.ts
function asSpan(node) {
	return node ?? {};
}
function nodeOffset(node, end = false) {
	const n = asSpan(node);
	if (end) return n.span?.end ?? n.end ?? 0;
	return n.span?.start ?? n.start ?? 0;
}
function locFromSpan(node, lines, end = false) {
	const offset = nodeOffset(node, end);
	let line = 1;
	let col = 1;
	let pos = 0;
	for (const l of lines) {
		const len = l.length + 1;
		if (pos + len > offset) {
			col = offset - pos + 1;
			break;
		}
		pos += len;
		line++;
	}
	const result = {
		line,
		column: col
	};
	if (end) {
		result.endLine = line;
		result.endColumn = col;
	}
	return result;
}
function locFromOffset(offset, lines) {
	return locFromSpan({ start: offset }, lines);
}
//#endregion
//#region src/graph/ast-walk.ts
function toAst(node) {
	return node;
}
function walk(node, visitor) {
	visitor(node);
	for (const key of Object.keys(node)) {
		const val = node[key];
		if (!val || typeof val !== "object") continue;
		if (Array.isArray(val)) {
			for (const child of val) if (child && typeof child === "object" && "type" in child) walk(child, visitor);
		} else if ("type" in val) walk(val, visitor);
	}
}
function walkWithParent(node, visitor, parent = null) {
	visitor(node, parent);
	for (const key of Object.keys(node)) {
		const val = node[key];
		if (!val || typeof val !== "object") continue;
		if (Array.isArray(val)) {
			for (const child of val) if (child && typeof child === "object" && "type" in child) walkWithParent(child, visitor, node);
		} else if ("type" in val) walkWithParent(val, visitor, node);
	}
}
/** Read a string from oxc Literal / StringLiteral / Identifier-like nodes. */
function stringLiteralValue(node) {
	if (!node) return null;
	if ((node.type === "Literal" || node.type === "StringLiteral") && typeof node.value === "string") return node.value;
	return null;
}
function exportedName(exported) {
	if (!exported) return "";
	if (exported.type === "Identifier" || exported.type === "IdentifierName") return typeof exported.name === "string" ? exported.name : "";
	if (exported.type === "Literal" || exported.type === "StringLiteral") return typeof exported.value === "string" ? exported.value : "";
	return "";
}
//#endregion
//#region src/graph/signals.ts
const BROWSER_GLOBALS = new Set([
	"window",
	"document",
	"navigator",
	"localStorage",
	"sessionStorage"
]);
const NODE_BUILTINS = new Set([
	"fs",
	"path",
	"crypto",
	"os",
	"child_process",
	"net",
	"tls",
	"dns",
	"stream",
	"buffer",
	"util",
	"http",
	"https",
	"zlib",
	"readline",
	"worker_threads"
]);
function extractSignals(source, program) {
	const signals = {
		hooks: [],
		eventHandlers: [],
		browserGlobals: [],
		nodeBuiltins: [],
		envReads: [],
		jsxElements: 0,
		largestLiteralBytes: 0,
		components: [],
		useEffectCalls: []
	};
	const lines = source.split("\n");
	for (const imp of program.body) {
		if (imp.type === "ImportDeclaration") {
			const base = (imp.source?.value ?? "").replace(/^node:/, "");
			if (NODE_BUILTINS.has(base)) signals.nodeBuiltins.push(locFromSpan(imp, lines));
		}
		if (imp.type === "VariableDeclaration") {
			for (const decl of imp.declarations) if (decl.init?.type === "CallExpression") {
				const callee = decl.init.callee;
				if (callee.type === "Identifier" && callee.name === "require") {
					const arg = decl.init.arguments[0];
					const value = arg ? stringLiteralValue(toAst(arg)) : null;
					if (value) {
						const base = value.replace(/^node:/, "");
						if (NODE_BUILTINS.has(base)) signals.nodeBuiltins.push(locFromSpan(decl, lines));
					}
				}
			}
		}
	}
	walkWithParent(toAst(program), (node, parent) => {
		if (node.type === "CallExpression") {
			const callee = node.callee;
			if (callee?.type === "Identifier") {
				const name = callee.name;
				if (/^use[A-Z]/.test(name) || name === "useEffect" || name === "useState") signals.hooks.push(locFromSpan(node, lines));
				const args = node.arguments ?? [];
				if (name === "useEffect" && args[1]) {
					const deps = args[1];
					signals.useEffectCalls.push({
						loc: locFromSpan(node, lines),
						depsEmpty: deps.type === "ArrayExpression" && deps.elements.length === 0
					});
				}
			}
		}
		if (node.type === "MemberExpression") {
			const envName = getProcessEnvName(node);
			if (envName) signals.envReads.push({
				name: envName,
				loc: locFromSpan(node, lines)
			});
			const obj = node.object;
			if (obj?.type === "Identifier" && BROWSER_GLOBALS.has(obj.name) && !isTypeofGuard(node, parent)) signals.browserGlobals.push(locFromSpan(node, lines));
		}
		if (node.type === "JSXElement" || node.type === "JSXFragment") signals.jsxElements++;
		if (node.type === "JSXAttribute") {
			const name = node.name;
			if (name?.type === "JSXIdentifier" && /^on[A-Z]/.test(name.name)) signals.eventHandlers.push(locFromSpan(node, lines));
		}
		if (node.type === "ObjectExpression" || node.type === "ArrayExpression") {
			const span = nodeSpan(node);
			if (span > signals.largestLiteralBytes) signals.largestLiteralBytes = span;
		}
	});
	extractComponents(program, signals, lines);
	return signals;
}
function extractComponents(program, signals, lines) {
	for (const stmt of program.body) {
		if (stmt.type === "FunctionDeclaration" && stmt.id?.name && /^[A-Z]/.test(stmt.id.name)) {
			if (stmt.body?.type === "BlockStatement") {
				const start = locFromSpan(stmt, lines);
				const end = locFromSpan(stmt, lines, true);
				const count = countSignalsInRange(signals, start.line, end.endLine ?? start.line);
				signals.components.push({
					name: stmt.id.name,
					loc: start,
					endLoc: end,
					signals: count
				});
			}
		}
		if (stmt.type === "VariableDeclaration") {
			for (const decl of stmt.declarations) if (decl.id.type === "Identifier" && /^[A-Z]/.test(decl.id.name) && (decl.init?.type === "ArrowFunctionExpression" || decl.init?.type === "FunctionExpression")) {
				const start = locFromSpan(decl, lines);
				const end = locFromSpan(decl, lines, true);
				const count = countSignalsInRange(signals, start.line, end.endLine ?? start.line);
				signals.components.push({
					name: decl.id.name,
					loc: start,
					endLoc: end,
					signals: count
				});
			}
		}
	}
}
function countSignalsInRange(signals, startLine, endLine) {
	const inRange = (l) => l.line >= startLine && l.line <= endLine;
	return signals.hooks.filter(inRange).length + signals.eventHandlers.filter(inRange).length + signals.browserGlobals.filter(inRange).length;
}
function isTypeofGuard(node, parent) {
	return parent?.type === "UnaryExpression";
}
function getProcessEnvName(node) {
	const property = node.property;
	const object = node.object;
	if (property?.type === "Identifier" && object?.type === "MemberExpression" && object.object?.type === "Identifier" && object.object.name === "process" && object.property?.type === "Identifier" && object.property.name === "env") return property.name;
	return null;
}
function nodeSpan(node) {
	const start = node.span?.start ?? node.start;
	const end = node.span?.end ?? node.end;
	if (start == null || end == null) return 0;
	return end - start;
}
//#endregion
//#region src/graph/directives.ts
const PROLOGUE_DIRECTIVES = new Set(["use client", "use server"]);
function extractDirectives(program) {
	const directives = /* @__PURE__ */ new Set();
	for (const stmt of program.body) {
		if (stmt.type === "ImportDeclaration") {
			const spec = stmt.source?.value ?? "";
			if (spec === "server-only") directives.add("server-only");
			if (spec === "client-only") directives.add("client-only");
			continue;
		}
		if (stmt.type === "ExpressionStatement") {
			const value = stringLiteralValue(toAst(stmt.expression));
			if (value && PROLOGUE_DIRECTIVES.has(value)) directives.add(value);
			continue;
		}
		if (stmt.type !== "EmptyStatement") break;
	}
	return directives;
}
//#endregion
//#region src/graph/package-info.ts
const installSizeCache = /* @__PURE__ */ new Map();
function loadPackageInfo(projectRoot) {
	const pkgPath = join(projectRoot, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	const installSizes = /* @__PURE__ */ new Map();
	const nodeModules = join(projectRoot, "node_modules");
	const allDeps = {
		...pkg.dependencies,
		...pkg.devDependencies,
		...pkg.peerDependencies
	};
	for (const name of Object.keys(allDeps)) installSizes.set(name, installSize(nodeModules, name));
	return {
		dependencies: pkg.dependencies ?? {},
		devDependencies: pkg.devDependencies ?? {},
		installSizes,
		lockfileVersions: parseLockfile(projectRoot)
	};
}
function installSize(nodeModules, pkgName) {
	const pkgDir = join(nodeModules, pkgName);
	if (!existsSync(pkgDir)) return 0;
	try {
		return du$1(pkgDir);
	} catch {
		return 0;
	}
}
function du$1(dir) {
	const cached = installSizeCache.get(dir);
	if (cached != null) return cached;
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			total += du$1(path);
		} else total += statSync(path).size;
	}
	installSizeCache.set(dir, total);
	return total;
}
function parseLockfile(projectRoot) {
	const versions = /* @__PURE__ */ new Map();
	const pnpmLock = join(projectRoot, "pnpm-lock.yaml");
	if (existsSync(pnpmLock)) {
		const content = readFileSync(pnpmLock, "utf-8");
		for (const m of content.matchAll(/\/(@?[^/@]+(?:\/[^/@]+)?)@([^:]+):/g)) {
			const [, name, version] = m;
			const list = versions.get(name) ?? [];
			if (!list.includes(version)) list.push(version);
			versions.set(name, list);
		}
	}
	return versions;
}
function getPackageName(specifier) {
	if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
	if (specifier.startsWith("@")) {
		const parts = specifier.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	}
	return specifier.split("/")[0];
}
//#endregion
//#region src/graph/imports.ts
function extractImports(filePath, source, program, projectRoot, resolver, resolveImport) {
	const imports = [];
	const lines = source.split("\n");
	const dynamicSpecifiers = collectDynamicSpecifiers(program);
	for (const stmt of program.body) {
		if (stmt.type === "ImportDeclaration") {
			const specifier = stmt.source?.value ?? "";
			const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
			imports.push({
				specifier,
				resolvedPath: resolved,
				packageName: getPackageName(specifier),
				namedSymbols: stmt.specifiers?.map((s) => {
					if (s.type === "ImportDefaultSpecifier") return "default";
					if (s.type === "ImportNamespaceSpecifier") return "*";
					return s.local?.name ?? "";
				}) ?? [],
				isDynamic: false,
				isTypeOnly: stmt.importKind === "type",
				loc: locFromSpan(stmt, lines)
			});
		}
		if (stmt.type === "ExportAllDeclaration" && stmt.source) {
			const specifier = stmt.source.value;
			const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
			imports.push({
				specifier,
				resolvedPath: resolved,
				packageName: getPackageName(specifier),
				namedSymbols: ["*"],
				isDynamic: false,
				isTypeOnly: false,
				loc: locFromSpan(stmt, lines)
			});
		}
		if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
			const specifier = stmt.source.value;
			const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
			imports.push({
				specifier,
				resolvedPath: resolved,
				packageName: getPackageName(specifier),
				namedSymbols: stmt.specifiers?.map((s) => exportedName(toAst(s.exported))) ?? [],
				isDynamic: false,
				isTypeOnly: false,
				loc: locFromSpan(stmt, lines)
			});
		}
	}
	walk(toAst(program), (node) => {
		if (node.type !== "ImportExpression") return;
		const specifier = stringLiteralValue(node.source);
		if (!specifier) return;
		const resolved = resolveImport(filePath, specifier, projectRoot, resolver);
		imports.push({
			specifier,
			resolvedPath: resolved,
			packageName: getPackageName(specifier),
			namedSymbols: ["default"],
			isDynamic: true,
			isTypeOnly: false,
			loc: locFromSpan(node, lines)
		});
	});
	for (const imp of imports) if (dynamicSpecifiers.has(imp.specifier)) imp.isDynamic = true;
	return imports;
}
function collectDynamicSpecifiers(program) {
	const specifiers = /* @__PURE__ */ new Set();
	walk(toAst(program), (node) => {
		if (node.type !== "CallExpression") return;
		const callee = node.callee;
		if (!isNextDynamicCallee(callee)) return;
		for (const arg of node.arguments ?? []) {
			const inner = findImportExpression(arg);
			if (!inner) continue;
			const value = stringLiteralValue(inner.source);
			if (value) specifiers.add(value);
		}
	});
	return specifiers;
}
function isNextDynamicCallee(callee) {
	if (callee.type === "Identifier" && callee.name === "dynamic") return true;
	if (callee.type !== "MemberExpression") return false;
	const obj = callee.object;
	const prop = callee.property;
	if (obj.type === "Identifier" && obj.name === "dynamic") return true;
	if (prop.type !== "Identifier" || prop.name !== "dynamic") return false;
	if (obj.type === "Identifier" && obj.name === "nextDynamic") return true;
	return false;
}
function findImportExpression(node) {
	if (node.type === "ImportExpression") return node;
	if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
		const body = node.body;
		if (body.type === "ImportExpression") return body;
		if (body.type === "BlockStatement") {
			for (const stmt of body.body ?? []) if (stmt.type === "ReturnStatement") {
				const arg = stmt.argument;
				if (arg?.type === "ImportExpression") return arg;
			}
		}
	}
	return null;
}
//#endregion
//#region src/graph/builder.ts
const SOURCE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const APP_DIRS = [
	"app",
	"src/app",
	"pages",
	"src/pages",
	"middleware.ts",
	"src/middleware.ts"
];
function findTsconfig(projectRoot) {
	for (const name of ["tsconfig.json", "jsconfig.json"]) {
		const path = join(projectRoot, name);
		if (existsSync(path)) return path;
	}
	return null;
}
async function buildGraph(projectRoot) {
	const tsconfig = findTsconfig(projectRoot);
	const resolver = new ResolverFactory({
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs",
			".json"
		],
		conditionNames: [
			"import",
			"require",
			"node",
			"default"
		],
		...tsconfig ? { tsconfig: {
			configFile: tsconfig,
			references: "auto"
		} } : {}
	});
	const entries = findEntries(projectRoot);
	const modules = /* @__PURE__ */ new Map();
	const pending = [...entries];
	const visited = /* @__PURE__ */ new Set();
	while (pending.length > 0) {
		const filePath = pending.pop();
		if (visited.has(filePath)) continue;
		visited.add(filePath);
		if (!existsSync(filePath)) continue;
		const ext = extname(filePath);
		if (!SOURCE_EXTS.has(ext) && !filePath.endsWith("middleware.ts")) continue;
		const source = readFileSync(filePath, "utf-8");
		const parsed = parseSync(filePath, source, { sourceType: "module" });
		const lines = source.split("\n");
		const directives = extractDirectives(parsed.program);
		const imports = extractImports(filePath, source, parsed.program, projectRoot, resolver, resolveImport);
		const exports = extractExports(parsed.program, lines);
		const signals = extractSignals(source, parsed.program);
		const sourceBytes = statSync(filePath).size;
		const mod = {
			filePath,
			env: "server",
			isBoundary: directives.has("use client"),
			directives,
			imports,
			exports,
			ast: () => parsed.program,
			signals,
			sourceBytes,
			subtreeBytes: 0,
			importChainFromEntry: [filePath],
			dependents: []
		};
		modules.set(filePath, mod);
		for (const imp of imports) if (imp.resolvedPath && !visited.has(imp.resolvedPath)) pending.push(imp.resolvedPath);
	}
	buildDependents(modules);
	classifyBoundaries(modules, entries);
	computeSubtreeBytes(modules);
	computeImportChains(modules, entries);
	trackExportReferences(modules);
	const clientModules = /* @__PURE__ */ new Set();
	const serverModules = /* @__PURE__ */ new Set();
	const sharedModules = /* @__PURE__ */ new Set();
	for (const [path, mod] of modules) if (mod.env === "client") clientModules.add(path);
	else if (mod.env === "shared") sharedModules.add(path);
	else serverModules.add(path);
	return {
		modules,
		entries,
		clientModules,
		serverModules,
		sharedModules
	};
}
function findEntries(projectRoot) {
	const entries = [];
	for (const dir of APP_DIRS) {
		const full = join(projectRoot, dir);
		if (!existsSync(full)) continue;
		if (statSync(full).isFile()) {
			entries.push(full);
			continue;
		}
		walkDir(full, entries);
	}
	return entries;
}
function walkDir(dir, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			walkDir(path, out);
		} else if (SOURCE_EXTS.has(extname(entry.name))) out.push(path);
	}
}
function resolveImport(from, specifier, projectRoot, resolver) {
	const fromFile = resolver.resolveFileSync(from, specifier);
	if (fromFile.path) return fromFile.path;
	if (specifier.startsWith(".") || specifier.startsWith("/")) {
		const result = resolver.sync(dirname(from), specifier);
		if (result.path) return result.path;
		return null;
	}
	const result = resolver.sync(join(projectRoot, "node_modules", specifier.split("/")[0]), specifier);
	if (result.path) return result.path;
	return resolver.sync(projectRoot, specifier).path ?? null;
}
function extractExports(program, lines) {
	const exports = [];
	for (const stmt of program.body) {
		if (stmt.type === "ExportNamedDeclaration") {
			if (stmt.declaration?.type === "FunctionDeclaration" && stmt.declaration.id) exports.push({
				name: stmt.declaration.id.name,
				loc: locFromSpan(stmt.declaration, lines),
				referencedBy: [],
				isAsync: stmt.declaration.async ?? false
			});
			if (stmt.declaration?.type === "VariableDeclaration") {
				for (const decl of stmt.declaration.declarations) if (decl.id.type === "Identifier") exports.push({
					name: decl.id.name,
					loc: locFromSpan(decl, lines),
					referencedBy: [],
					isAsync: false
				});
			}
			for (const spec of stmt.specifiers ?? []) {
				const exported = spec.exported?.type === "Identifier" ? spec.exported.name : spec.exported?.type === "Literal" ? String(spec.exported.value) : "";
				const local = spec.local?.type === "Identifier" ? spec.local.name : "";
				exports.push({
					name: exported || local,
					loc: locFromSpan(spec, lines),
					referencedBy: [],
					isAsync: false
				});
			}
		}
		if (stmt.type === "ExportDefaultDeclaration") exports.push({
			name: "default",
			loc: locFromSpan(stmt, lines),
			referencedBy: [],
			isAsync: false
		});
		if (stmt.type === "FunctionDeclaration" && stmt.id) exports.push({
			name: stmt.id.name,
			loc: locFromSpan(stmt, lines),
			referencedBy: [],
			isAsync: stmt.async ?? false
		});
		if (stmt.type === "VariableDeclaration") {
			for (const decl of stmt.declarations) if (decl.id.type === "Identifier") exports.push({
				name: decl.id.name,
				loc: locFromSpan(decl, lines),
				referencedBy: [],
				isAsync: false
			});
		}
	}
	if (sourceHasMetadata(program)) {
		exports.push({
			name: "metadata",
			loc: {
				line: 1,
				column: 1
			},
			referencedBy: [],
			isAsync: false
		});
		exports.push({
			name: "generateMetadata",
			loc: {
				line: 1,
				column: 1
			},
			referencedBy: [],
			isAsync: false
		});
	}
	return exports;
}
function sourceHasMetadata(program) {
	for (const stmt of program.body) if (stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration") {
		for (const decl of stmt.declaration.declarations) if (decl.id.type === "Identifier" && (decl.id.name === "metadata" || decl.id.name === "generateMetadata")) return true;
	}
	return false;
}
function buildDependents(modules) {
	for (const mod of modules.values()) for (const imp of mod.imports) if (imp.resolvedPath && modules.has(imp.resolvedPath)) modules.get(imp.resolvedPath).dependents.push(mod.filePath);
}
function classifyBoundaries(modules, entries) {
	const clientReachable = /* @__PURE__ */ new Set();
	const queue = [];
	for (const [path, mod] of modules) if (mod.isBoundary || mod.directives.has("client-only")) {
		clientReachable.add(path);
		queue.push(path);
	}
	while (queue.length > 0) {
		const current = queue.shift();
		const mod = modules.get(current);
		if (!mod) continue;
		for (const imp of mod.imports) {
			if (imp.isDynamic) continue;
			if (imp.resolvedPath && !clientReachable.has(imp.resolvedPath)) {
				clientReachable.add(imp.resolvedPath);
				queue.push(imp.resolvedPath);
			}
		}
	}
	const entrySet = new Set(entries);
	for (const [path, mod] of modules) if (clientReachable.has(path)) mod.env = "client";
	else if (mod.directives.has("server-only") || mod.directives.has("use server")) mod.env = "server";
	else if (entrySet.has(path) || isAppRoute(path)) mod.env = "server";
	else {
		const usedByClient = mod.dependents.some((d) => clientReachable.has(d));
		const usedByServer = mod.dependents.some((d) => !clientReachable.has(d));
		if (usedByClient && usedByServer) mod.env = "shared";
		else if (usedByClient) mod.env = "client";
		else mod.env = "server";
	}
}
function isAppRoute(filePath) {
	return /\/(page|layout|template|loading|error|not-found|route)\.(t|j)sx?$/.test(filePath);
}
function computeSubtreeBytes(modules) {
	for (const mod of modules.values()) {
		const visited = /* @__PURE__ */ new Set();
		const stack = [mod.filePath];
		let total = 0;
		while (stack.length > 0) {
			const p = stack.pop();
			if (visited.has(p)) continue;
			visited.add(p);
			const m = modules.get(p);
			if (!m) continue;
			total += m.sourceBytes;
			for (const imp of m.imports) if (imp.resolvedPath) stack.push(imp.resolvedPath);
		}
		mod.subtreeBytes = total;
	}
}
function computeImportChains(modules, entries) {
	for (const mod of modules.values()) {
		const visited = /* @__PURE__ */ new Set();
		const queue = entries.map((e) => ({
			path: e,
			chain: [e]
		}));
		while (queue.length > 0) {
			const { path, chain } = queue.shift();
			if (path === mod.filePath) {
				mod.importChainFromEntry = chain;
				break;
			}
			if (visited.has(path)) continue;
			visited.add(path);
			const m = modules.get(path);
			if (!m) continue;
			for (const imp of m.imports) if (imp.resolvedPath) queue.push({
				path: imp.resolvedPath,
				chain: [...chain, imp.resolvedPath]
			});
		}
	}
}
function trackExportReferences(modules) {
	for (const mod of modules.values()) for (const imp of mod.imports) {
		if (!imp.resolvedPath || !modules.has(imp.resolvedPath)) continue;
		const target = modules.get(imp.resolvedPath);
		for (const sym of imp.namedSymbols) {
			const exp = target.exports.find((e) => e.name === sym || sym === "*");
			if (exp) exp.referencedBy.push({
				modulePath: mod.filePath,
				symbols: imp.namedSymbols
			});
		}
	}
}
function relPath(projectRoot, filePath) {
	return relative(projectRoot, filePath);
}
function isClientOnlyPackage(packageName, data) {
	return data.heavyPackages.has(packageName) || data.heavyComponents.has(packageName);
}
//#endregion
//#region src/data/heavy-packages.json
var heavy_packages_default = [
	"moment",
	"moment-timezone",
	"lodash",
	"lodash-es",
	"rxjs",
	"aws-sdk",
	"@aws-sdk/client-s3",
	"firebase",
	"firebase-admin",
	"pdfjs-dist",
	"fabric",
	"draft-js",
	"immutable",
	"core-js"
];
//#endregion
//#region src/data/framework-packages.json
var framework_packages_default = ["next"];
//#endregion
//#region src/data/category-map.json
var category_map_default = {
	dates: [
		"moment",
		"dayjs",
		"date-fns",
		"luxon"
	],
	icons: [
		"react-icons",
		"lucide-react",
		"@mui/icons-material",
		"@heroicons/react"
	],
	utils: [
		"lodash",
		"lodash-es",
		"ramda",
		"underscore"
	],
	http: [
		"axios",
		"ky",
		"superagent",
		"node-fetch"
	],
	state: [
		"redux",
		"zustand",
		"jotai",
		"mobx",
		"recoil"
	],
	forms: [
		"formik",
		"react-hook-form",
		"final-form"
	]
};
//#endregion
//#region src/data/on-demand-libs.json
var on_demand_libs_default = [
	"jspdf",
	"html2canvas",
	"xlsx",
	"exceljs",
	"file-saver",
	"jszip",
	"qrcode",
	"papaparse"
];
//#endregion
//#region src/data/heavy-components.json
var heavy_components_default = [
	"recharts",
	"chart.js",
	"echarts",
	"monaco-editor",
	"@monaco-editor/react",
	"codemirror",
	"@codemirror/view",
	"@tiptap/react",
	"@tiptap/starter-kit",
	"leaflet",
	"mapbox-gl",
	"three",
	"@react-three/fiber"
];
//#endregion
//#region src/data/barrel-packages.json
var barrel_packages_default = [
	"lodash",
	"lodash-es",
	"react-icons",
	"@mui/icons-material",
	"date-fns",
	"ramda",
	"antd",
	"lucide-react",
	"@heroicons/react",
	"@tabler/icons-react"
];
//#endregion
//#region src/data/index.ts
function loadDataTables() {
	return {
		heavyPackages: new Set(heavy_packages_default),
		frameworkPackages: new Set(framework_packages_default),
		categoryMap: category_map_default,
		onDemandLibs: new Set(on_demand_libs_default),
		heavyComponents: new Set(heavy_components_default),
		barrelPackages: new Set(barrel_packages_default)
	};
}
//#endregion
//#region src/config.ts
const DEFAULT_CONFIG = {
	thresholds: {
		subtreeBytesHigh: 5e4,
		largeLiteralBytes: 10240,
		largeJsonBytes: 20480,
		heavyPackageBytes: 512e3,
		middlewareSourceBytes: 204800,
		middlewarePackageBytes: 102400,
		routeBudgetBytes: 5e5,
		interactiveLeafRatio: .25,
		barrelReexportRatio: .8,
		barrelMinReexports: 5,
		iconMapMinEntries: 10,
		componentMapMinEntries: 10,
		componentMapMinImports: 5,
		inlineSvgMinCount: 10,
		inlineSvgMinBytes: 30720,
		dynamicImportMinSubtree: 20480,
		dynamicMisuseMaxSubtree: 5120,
		clientSignalRatio: .3,
		providerMinImports: 2,
		providerMaxInstallSize: 102400,
		searchIndexMinBytes: 20480,
		base64MinBytes: 5120,
		rscPayloadMaxFields: 3
	},
	ignores: {
		files: [],
		rules: []
	},
	severityOverrides: {}
};
function mergeConfig(defaults, user) {
	return {
		thresholds: {
			...defaults.thresholds,
			...user.thresholds
		},
		ignores: {
			files: dedupe([...defaults.ignores.files ?? [], ...user.ignores?.files ?? []]),
			rules: dedupe([...defaults.ignores.rules ?? [], ...user.ignores?.rules ?? []])
		},
		severityOverrides: {
			...defaults.severityOverrides,
			...user.severityOverrides
		}
	};
}
function dedupe(items) {
	return [...new Set(items)];
}
async function loadConfig(projectRoot) {
	const configPath = join(projectRoot, "wimb.config.ts");
	if (!existsSync(configPath)) return DEFAULT_CONFIG;
	try {
		return mergeConfig(DEFAULT_CONFIG, (await import(configPath)).default ?? {});
	} catch {
		return DEFAULT_CONFIG;
	}
}
function parseNextConfigFromSource(content) {
	return {
		distDir: extractStringProp(content, "distDir") ?? ".next",
		optimizePackageImports: extractArrayProp(content, "optimizePackageImports") ?? [],
		webpackFallbacks: extractWebpackFallbacks(content),
		resolveAliases: extractResolveAliases(content)
	};
}
function normalizeNextConfig(raw) {
	const obj = raw.default ?? raw;
	const distDir = typeof obj.distDir === "string" ? obj.distDir : ".next";
	const optimize = Array.isArray(obj.optimizePackageImports) ? obj.optimizePackageImports.filter((x) => typeof x === "string") : [];
	const fallbacks = [];
	const aliases = [];
	if (typeof obj.webpack === "function") {}
	const experimental = obj.experimental;
	if (experimental && Array.isArray(experimental.optimizePackageImports)) {
		for (const item of experimental.optimizePackageImports) if (typeof item === "string") optimize.push(item);
	}
	return {
		distDir,
		optimizePackageImports: [...new Set(optimize)],
		webpackFallbacks: fallbacks,
		resolveAliases: aliases
	};
}
async function tryLoadNextConfig(configPath) {
	try {
		if (configPath.endsWith(".ts")) {
			const { createJiti } = await import("jiti");
			return createJiti(import.meta.url, { interopDefault: true })(configPath);
		}
		const mod = await import(pathToFileURL(configPath).href);
		return mod.default ?? mod;
	} catch {
		return null;
	}
}
async function parseNextConfig(projectRoot) {
	for (const name of [
		"next.config.ts",
		"next.config.mjs",
		"next.config.js"
	]) {
		const path = join(projectRoot, name);
		if (!existsSync(path)) continue;
		const loaded = await tryLoadNextConfig(path);
		if (loaded) return normalizeNextConfig(loaded);
		return parseNextConfigFromSource(readFileSync(path, "utf-8"));
	}
	return null;
}
function extractStringProp(content, prop) {
	const re = new RegExp(`${prop}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
	return content.match(re)?.[1] ?? null;
}
function extractArrayProp(content, prop) {
	const re = new RegExp(`${prop}\\s*:\\s*\\[([^\\]]+)\\]`);
	const m = content.match(re);
	if (!m) return null;
	return [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
}
function extractWebpackFallbacks(content) {
	const fallbacks = [];
	const re = /fallback\s*:\s*\{([^}]+)\}/g;
	let m;
	while (m = re.exec(content)) for (const key of m[1].matchAll(/['"`]?(\w+)['"`]?\s*:/g)) fallbacks.push(key[1]);
	return fallbacks;
}
function extractResolveAliases(content) {
	const aliases = [];
	const re = /alias\s*:\s*\{([^}]+)\}/g;
	let m;
	while (m = re.exec(content)) for (const key of m[1].matchAll(/['"`]([^'"`]+)['"`]\s*:/g)) aliases.push(key[1]);
	return aliases;
}
//#endregion
//#region src/rules/helpers.ts
function reportFinding(ctx, partial) {
	const finding = makeFinding(ctx, partial);
	if (finding) ctx.report(finding);
}
function makeFinding(ctx, partial) {
	const override = ctx.config.severityOverrides[partial.ruleId];
	const site = resolveReportSite(ctx, partial.file, partial.loc);
	if (!site) return null;
	const file = site.file.startsWith("/") || site.file.includes(ctx.projectRoot) ? relPath(ctx.projectRoot, site.file) : site.file;
	return {
		...partial,
		severity: override ?? partial.defaultSeverity,
		file,
		loc: site.loc
	};
}
function projectClientModulePaths(ctx) {
	return [...ctx.graph.clientModules].filter((path) => isProjectSource(ctx, path));
}
function isFrameworkPackage(ctx, packageName) {
	return ctx.data.frameworkPackages.has(packageName);
}
function isIgnored(ctx, ruleId, file) {
	if (ctx.config.ignores.rules.includes(ruleId)) return true;
	return ctx.config.ignores.files.some((p) => file.includes(p));
}
function isProjectSource(ctx, filePath) {
	const abs = toAbsolutePath(ctx, filePath);
	if (abs.includes("/node_modules/") || abs.includes("\\node_modules\\")) return false;
	return !relative(ctx.projectRoot, abs).startsWith("..");
}
function resolveReportSite(ctx, filePath, loc) {
	if (isProjectSource(ctx, filePath)) return {
		file: filePath,
		loc
	};
	const directImporter = findDirectProjectImporter(ctx, filePath);
	if (directImporter) return directImporter;
	const mod = ctx.graph.modules.get(toAbsolutePath(ctx, filePath));
	if (mod) {
		const fromChain = importSiteFromChain(ctx, mod);
		if (fromChain) return fromChain;
	}
	return null;
}
function toAbsolutePath(ctx, filePath) {
	if (filePath.startsWith("/")) return filePath;
	if (filePath.includes(ctx.projectRoot)) return filePath;
	return resolve(ctx.projectRoot, filePath);
}
function findDirectProjectImporter(ctx, targetPath) {
	const targetAbs = toAbsolutePath(ctx, targetPath);
	for (const mod of ctx.graph.modules.values()) {
		if (!isProjectSource(ctx, mod.filePath)) continue;
		for (const imp of mod.imports) {
			if (!imp.resolvedPath) continue;
			if (imp.resolvedPath === targetAbs || targetAbs.startsWith(`${imp.resolvedPath}/`)) return {
				file: mod.filePath,
				loc: imp.loc
			};
			if (imp.packageName && packagePathMatches(targetAbs, imp.packageName)) return {
				file: mod.filePath,
				loc: imp.loc
			};
		}
	}
	return null;
}
function importSiteFromChain(ctx, mod) {
	for (let i = mod.importChainFromEntry.length - 2; i >= 0; i--) {
		const candidate = mod.importChainFromEntry[i];
		if (!isProjectSource(ctx, candidate)) continue;
		const candidateMod = ctx.graph.modules.get(candidate);
		if (!candidateMod) return { file: candidate };
		return {
			file: candidate,
			loc: candidateMod.imports.find((i) => i.resolvedPath === mod.filePath || i.resolvedPath && mod.filePath.startsWith(`${i.resolvedPath}/`) || i.packageName && packagePathMatches(mod.filePath, i.packageName))?.loc
		};
	}
	return null;
}
function packagePathMatches(filePath, packageName) {
	return filePath.includes(`/node_modules/${packageName}/`) || filePath.includes(`\\node_modules\\${packageName}\\`);
}
function packageInClientGraph(ctx, packageName) {
	const files = [];
	for (const path of projectClientModulePaths(ctx)) if (ctx.graph.modules.get(path).imports.some((i) => i.packageName === packageName)) files.push(relPath(ctx.projectRoot, path));
	return files;
}
function getInstallSize(ctx, packageName) {
	return ctx.pkg.installSizes.get(packageName) ?? 0;
}
function estimatedBytes(ctx, packageName) {
	if (ctx.byteAttribution?.modules.has(packageName)) return ctx.byteAttribution.modules.get(packageName);
	return getInstallSize(ctx, packageName);
}
/** True when package size came from next analyze attribution. */
function isMeasuredPackageBytes(ctx, packageName) {
	return Boolean(ctx.byteAttribution?.measured && ctx.byteAttribution.modules.has(packageName));
}
//#endregion
//#region src/rules/boundary/use-client-unnecessary.ts
const useClientUnnecessary = {
	id: "use-client-unnecessary",
	category: "boundary",
	defaultSeverity: "warning",
	run(ctx) {
		for (const mod of ctx.graph.modules.values()) {
			if (!mod.isBoundary) continue;
			if (!isProjectSource(ctx, mod.filePath)) continue;
			if (isIgnored(ctx, "use-client-unnecessary", mod.filePath)) continue;
			const { hooks, eventHandlers, browserGlobals } = mod.signals;
			if (hooks.length || eventHandlers.length || browserGlobals.length) continue;
			if (mod.imports.some((i) => i.packageName && isClientOnlyPackage(i.packageName, ctx.data))) continue;
			const hasReexports = mod.imports.some((i) => i.namedSymbols.includes("*"));
			reportFinding(ctx, {
				id: `${mod.filePath}:use-client-unnecessary`,
				ruleId: "use-client-unnecessary",
				category: "boundary",
				defaultSeverity: "warning",
				confidence: hasReexports ? "medium" : "high",
				file: mod.filePath,
				message: "File has 'use client' but no client signals or client-only dependencies",
				evidence: { importChain: mod.importChainFromEntry },
				fixStrategy: {
					name: "remove-use-client",
					steps: ["Delete the 'use client' directive", "Run build/typecheck to confirm no descendant needed the boundary"]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/boundary/use-client-too-high.ts
const useClientTooHigh = {
	id: "use-client-too-high",
	category: "boundary",
	defaultSeverity: "error",
	run(ctx) {
		const { subtreeBytesHigh, clientSignalRatio } = ctx.config.thresholds;
		for (const mod of ctx.graph.modules.values()) {
			if (!isProjectSource(ctx, mod.filePath)) continue;
			if (!mod.isBoundary) continue;
			if (isIgnored(ctx, "use-client-too-high", mod.filePath)) continue;
			if (!(/\/(layout|page|template)\.(t|j)sx?$/.test(mod.filePath) || mod.subtreeBytes > subtreeBytesHigh)) continue;
			const subtree = collectSubtree(ctx, mod.filePath);
			const withSignals = subtree.filter((m) => m.signals.hooks.length + m.signals.eventHandlers.length + m.signals.browserGlobals.length > 0);
			if (subtree.length === 0) continue;
			if (withSignals.length / subtree.length >= clientSignalRatio) continue;
			reportFinding(ctx, {
				id: `${mod.filePath}:use-client-too-high`,
				ruleId: "use-client-too-high",
				category: "boundary",
				defaultSeverity: "error",
				confidence: "medium",
				file: mod.filePath,
				message: "'use client' is placed too high — most of the subtree is server-safe",
				evidence: {
					signalModules: withSignals.map((m) => relPath(ctx.projectRoot, m.filePath)),
					subtreeBytes: mod.subtreeBytes
				},
				estimatedBytes: mod.subtreeBytes,
				fixStrategy: {
					name: "move-boundary-down",
					steps: [
						"Remove 'use client' from this file",
						"Add 'use client' to the listed signal-bearing descendants",
						"Pass server-rendered content via children/props"
					]
				}
			});
		}
	}
};
function collectSubtree(ctx, root) {
	const visited = /* @__PURE__ */ new Set();
	const stack = [root];
	const result = [];
	while (stack.length) {
		const p = stack.pop();
		if (visited.has(p)) continue;
		visited.add(p);
		const m = ctx.graph.modules.get(p);
		if (!m) continue;
		result.push(m);
		for (const imp of m.imports) if (imp.resolvedPath) stack.push(imp.resolvedPath);
	}
	return result;
}
//#endregion
//#region src/rules/boundary/index.ts
const boundaryRules = [useClientUnnecessary, useClientTooHigh];
//#endregion
//#region src/external/module-replacements.ts
const __dirname = dirname(fileURLToPath(import.meta.url));
function manifestPath(name) {
	const candidates = [join(process.cwd(), "node_modules", "module-replacements", "manifests", name), join(__dirname, "..", "..", "node_modules", "module-replacements", "manifests", name)];
	for (const p of candidates) if (existsSync(p)) return p;
	return null;
}
function loadReplacements() {
	const result = /* @__PURE__ */ new Map();
	for (const manifest of [
		"native.json",
		"micro-utilities.json",
		"preferred.json"
	]) {
		const path = manifestPath(manifest);
		if (!path) continue;
		try {
			const data = JSON.parse(readFileSync(path, "utf-8"));
			for (const [pkg, info] of Object.entries(data)) result.set(pkg, {
				replacement: info.replacement ?? info.native ?? "native API",
				manifest: manifest.replace(".json", ""),
				docsUrl: info.docs ?? info.url
			});
		} catch {}
	}
	return result;
}
//#endregion
//#region src/rules/dependency/replaceable-dependency.ts
const replaceableDependency = {
	id: "replaceable-dependency",
	category: "dependency",
	defaultSeverity: "warning",
	run(ctx) {
		const replacements = loadReplacements();
		const seen = /* @__PURE__ */ new Set();
		for (const [pkg, info] of replacements) {
			const files = packageInClientGraph(ctx, pkg);
			if (!files.length || seen.has(pkg)) continue;
			seen.add(pkg);
			if (isIgnored(ctx, "replaceable-dependency", pkg)) continue;
			reportFinding(ctx, {
				id: `pkg:${pkg}:replaceable-dependency`,
				ruleId: "replaceable-dependency",
				category: "dependency",
				defaultSeverity: "warning",
				confidence: "high",
				file: files[0],
				message: `Package '${pkg}' has a lighter replacement: ${info.replacement}`,
				evidence: {
					package: pkg,
					manifest: info.manifest,
					docsUrl: info.docsUrl,
					files
				},
				fixStrategy: {
					name: "swap-dependency",
					steps: [`Review replacement docs: ${info.docsUrl ?? "module-replacements manifest"}`, `Run: npx @e18e/cli migrate ${pkg}`]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/dependency/heavy-client-import.ts
const heavyClientImport = {
	id: "heavy-client-import",
	category: "dependency",
	defaultSeverity: "error",
	run(ctx) {
		const { heavyPackageBytes } = ctx.config.thresholds;
		const seen = /* @__PURE__ */ new Set();
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				if (!imp.packageName || seen.has(`${path}:${imp.packageName}`)) continue;
				if (isFrameworkPackage(ctx, imp.packageName)) continue;
				const size = estimatedBytes(ctx, imp.packageName);
				const measured = isMeasuredPackageBytes(ctx, imp.packageName);
				if (!(measured ? size > heavyPackageBytes : size > heavyPackageBytes || ctx.data.heavyPackages.has(imp.packageName))) continue;
				seen.add(`${path}:${imp.packageName}`);
				if (isIgnored(ctx, "heavy-client-import", path)) continue;
				reportFinding(ctx, {
					id: `${path}:heavy-client-import:${imp.packageName}`,
					ruleId: "heavy-client-import",
					category: "dependency",
					defaultSeverity: "error",
					confidence: measured ? "high" : size > 0 ? "high" : "medium",
					file: path,
					loc: imp.loc,
					message: `Heavy package '${imp.packageName}' imported in client graph`,
					evidence: {
						package: imp.packageName,
						importChain: mod.importChainFromEntry,
						byteSource: measured ? "measured" : "estimated"
					},
					estimatedBytes: size,
					byteSource: measured ? "measured" : "estimated",
					fixStrategy: {
						name: "reduce-heavy-import",
						steps: [
							"Use a lighter alternative if available",
							"Move usage server-side",
							"Or use next/dynamic for on-demand loading"
						]
					}
				});
			}
		}
	}
};
//#endregion
//#region src/rules/dependency/barrel-import.ts
const barrelImport = {
	id: "barrel-import",
	category: "dependency",
	defaultSeverity: "warning",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				if (!imp.packageName || !ctx.data.barrelPackages.has(imp.packageName)) continue;
				if (imp.specifier.includes("/") && imp.specifier !== imp.packageName) continue;
				if (isIgnored(ctx, "barrel-import", path)) continue;
				reportFinding(ctx, {
					id: `${path}:barrel-import:${imp.packageName}`,
					ruleId: "barrel-import",
					category: "dependency",
					defaultSeverity: "warning",
					confidence: "high",
					file: path,
					loc: imp.loc,
					message: `Barrel import from '${imp.packageName}' — use deep imports or optimizePackageImports`,
					evidence: { specifier: imp.specifier },
					fixStrategy: {
						name: "deep-import",
						steps: [`Use deep import path (e.g. ${imp.packageName}/specific-export)`, "Or add package to experimental.optimizePackageImports in next.config"]
					}
				});
			}
		}
	}
};
//#endregion
//#region src/rules/dependency/runtime-css-in-js.ts
const CSS_IN_JS = [
	"styled-components",
	"@emotion/react",
	"@emotion/styled"
];
const runtimeCssInJs = {
	id: "runtime-css-in-js",
	category: "dependency",
	defaultSeverity: "info",
	run(ctx) {
		for (const pkg of CSS_IN_JS) {
			const files = packageInClientGraph(ctx, pkg);
			if (!files.length) continue;
			if (isIgnored(ctx, "runtime-css-in-js", pkg)) continue;
			reportFinding(ctx, {
				id: `pkg:${pkg}:runtime-css-in-js`,
				ruleId: "runtime-css-in-js",
				category: "dependency",
				defaultSeverity: "info",
				confidence: "high",
				file: files[0],
				message: `Runtime CSS-in-JS '${pkg}' increases client bundle — consider zero-runtime alternatives`,
				evidence: {
					package: pkg,
					files
				},
				fixStrategy: {
					name: "zero-runtime-css",
					steps: ["Consider Tailwind, CSS Modules, or vanilla-extract", "Low priority — opinionated suggestion"]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/dependency/transitive-heavy-dependency.ts
const transitiveHeavyDependency = {
	id: "transitive-heavy-dependency",
	category: "dependency",
	defaultSeverity: "warning",
	run(ctx) {
		const { heavyPackageBytes } = ctx.config.thresholds;
		const directImports = /* @__PURE__ */ new Set();
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) if (imp.packageName) directImports.add(imp.packageName);
		}
		for (const [pkg, size] of ctx.pkg.installSizes) {
			if (isFrameworkPackage(ctx, pkg)) continue;
			if (!(size > heavyPackageBytes || ctx.data.heavyPackages.has(pkg))) continue;
			if (![...ctx.graph.clientModules].some((p) => {
				return ctx.graph.modules.get(p).imports.some((i) => i.packageName === pkg);
			})) continue;
			if (directImports.has(pkg)) continue;
			if (isIgnored(ctx, "transitive-heavy-dependency", pkg)) continue;
			const chain = findChain(ctx, pkg);
			reportFinding(ctx, {
				id: `pkg:${pkg}:transitive-heavy-dependency`,
				ruleId: "transitive-heavy-dependency",
				category: "dependency",
				defaultSeverity: "warning",
				confidence: "medium",
				file: chain[0] ?? pkg,
				message: `Heavy package '${pkg}' reached transitively in client graph`,
				evidence: {
					package: pkg,
					chain: chain.map((p) => relPath(ctx.projectRoot, p))
				},
				estimatedBytes: size,
				fixStrategy: {
					name: "fix-transitive",
					steps: ["Replace or fork the intermediate dependency", "Check replaceable-dependency findings for the intermediate"]
				}
			});
		}
	}
};
function findChain(ctx, pkg) {
	for (const path of projectClientModulePaths(ctx)) {
		const mod = ctx.graph.modules.get(path);
		if (mod.imports.find((i) => i.packageName === pkg)) return [mod.filePath];
	}
	return [];
}
//#endregion
//#region src/rules/dependency/index.ts
const dependencyRules = [
	replaceableDependency,
	heavyClientImport,
	barrelImport,
	runtimeCssInJs,
	transitiveHeavyDependency,
	{
		id: "static-icon-map",
		category: "dependency",
		defaultSeverity: "warning",
		run(ctx) {
			const { iconMapMinEntries } = ctx.config.thresholds;
			for (const path of projectClientModulePaths(ctx)) {
				const iconImports = ctx.graph.modules.get(path).imports.filter((i) => i.packageName && (ctx.data.categoryMap.icons?.includes(i.packageName) || /icons?/i.test(i.packageName)));
				if (iconImports.length < iconMapMinEntries) continue;
				if (isIgnored(ctx, "static-icon-map", path)) continue;
				reportFinding(ctx, {
					id: `${path}:static-icon-map`,
					ruleId: "static-icon-map",
					category: "dependency",
					defaultSeverity: "warning",
					confidence: "high",
					file: path,
					message: "Large static icon map detected — imports many icon components",
					evidence: { iconImportCount: iconImports.length },
					fixStrategy: {
						name: "lazy-icons",
						steps: ["Use per-use direct imports", "Or a lazy map of dynamic(() => import(...)) entries"]
					}
				});
			}
		}
	}
];
//#endregion
//#region src/rules/loading/missing-dynamic-import.ts
const missingDynamicImport = {
	id: "missing-dynamic-import",
	category: "loading",
	defaultSeverity: "error",
	run(ctx) {
		const { dynamicImportMinSubtree } = ctx.config.thresholds;
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				if (!imp.packageName || !ctx.data.heavyComponents.has(imp.packageName)) continue;
				if (imp.isDynamic) continue;
				if (isIgnored(ctx, "missing-dynamic-import", path)) continue;
				reportFinding(ctx, {
					id: `${path}:missing-dynamic-import:${imp.packageName}`,
					ruleId: "missing-dynamic-import",
					category: "loading",
					defaultSeverity: "error",
					confidence: "medium",
					file: path,
					loc: imp.loc,
					message: `Heavy component '${imp.packageName}' statically imported — use next/dynamic`,
					evidence: { package: imp.packageName },
					estimatedBytes: mod.subtreeBytes,
					fixStrategy: {
						name: "dynamic-import",
						steps: ["Replace with next/dynamic(() => import(...))", "Add a loading fallback"]
					}
				});
			}
			for (const imp of mod.imports) {
				if (!imp.resolvedPath || imp.isDynamic) continue;
				const target = ctx.graph.modules.get(imp.resolvedPath);
				if (!target || target.subtreeBytes <= dynamicImportMinSubtree) continue;
				if (isIgnored(ctx, "missing-dynamic-import", path)) continue;
				reportFinding(ctx, {
					id: `${path}:missing-dynamic-import:local:${imp.resolvedPath}`,
					ruleId: "missing-dynamic-import",
					category: "loading",
					defaultSeverity: "error",
					confidence: "medium",
					file: path,
					loc: imp.loc,
					message: "Large local module statically imported — candidate for next/dynamic",
					evidence: {
						module: imp.resolvedPath,
						subtreeBytes: target.subtreeBytes
					},
					estimatedBytes: target.subtreeBytes,
					fixStrategy: {
						name: "conditional-dynamic",
						steps: ["Use next/dynamic for conditionally rendered large components"]
					}
				});
			}
		}
	}
};
//#endregion
//#region src/rules/loading/on-demand-feature-eager.ts
const onDemandFeatureEager = {
	id: "on-demand-feature-eager",
	category: "loading",
	defaultSeverity: "error",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				if (!imp.packageName || !ctx.data.onDemandLibs.has(imp.packageName)) continue;
				if (imp.isDynamic) continue;
				if (!mod.signals.eventHandlers.length) continue;
				if (isIgnored(ctx, "on-demand-feature-eager", path)) continue;
				reportFinding(ctx, {
					id: `${path}:on-demand-feature-eager:${imp.packageName}`,
					ruleId: "on-demand-feature-eager",
					category: "loading",
					defaultSeverity: "error",
					confidence: "high",
					file: path,
					loc: imp.loc,
					message: `On-demand lib '${imp.packageName}' eagerly imported but only used in handlers`,
					evidence: {
						package: imp.packageName,
						eventHandlers: mod.signals.eventHandlers.length
					},
					fixStrategy: {
						name: "handler-dynamic-import",
						steps: [`Replace with await import('${imp.packageName}') inside the event handler`]
					}
				});
			}
		}
	}
};
//#endregion
//#region src/rules/loading/next-dynamic-misuse.ts
const nextDynamicMisuse = {
	id: "next-dynamic-misuse",
	category: "loading",
	defaultSeverity: "info",
	run(ctx) {
		const { dynamicMisuseMaxSubtree } = ctx.config.thresholds;
		for (const mod of ctx.graph.modules.values()) {
			if (!isProjectSource(ctx, mod.filePath)) continue;
			if (!mod.imports.some((i) => i.isDynamic)) continue;
			for (const imp of mod.imports) {
				if (!imp.isDynamic || !imp.resolvedPath) continue;
				const target = ctx.graph.modules.get(imp.resolvedPath);
				if (target && target.subtreeBytes < dynamicMisuseMaxSubtree) {
					if (isIgnored(ctx, "next-dynamic-misuse", mod.filePath)) continue;
					reportFinding(ctx, {
						id: `${mod.filePath}:next-dynamic-misuse:small`,
						ruleId: "next-dynamic-misuse",
						category: "loading",
						defaultSeverity: "info",
						confidence: "high",
						file: mod.filePath,
						loc: imp.loc,
						message: "dynamic() used for a small module — overhead exceeds benefit",
						evidence: {
							module: imp.resolvedPath,
							subtreeBytes: target.subtreeBytes
						},
						fixStrategy: {
							name: "revert-static",
							steps: ["Revert to static import"]
						}
					});
				}
			}
		}
	}
};
//#endregion
//#region src/analysis/branch-exclusive-components.ts
const PATH_ROOT_NAMES = new Set([
	"pathname",
	"path",
	"asPath",
	"href",
	"route"
]);
function analyzeBranchExclusiveComponents(source, program, imports) {
	const lines = source.split("\n");
	const pathRoots = collectPathRoots(program);
	const candidates = [];
	walk(toAst(program), (node) => {
		if (node.type === "IfStatement") collectFromConditional(node.test, node.consequent, node.alternate ?? null, pathRoots, program, lines, candidates);
		if (node.type === "ConditionalExpression") collectFromConditional(node.test, node.consequent, node.alternate, pathRoots, program, lines, candidates);
	});
	if (candidates.length === 0) return [];
	const unconditional = collectUnconditionalComponents(program, lines);
	const importedSymbols = buildImportedSymbolSet(imports);
	const byComponent = /* @__PURE__ */ new Map();
	for (const c of candidates) {
		if (!importedSymbols.has(c.componentName)) continue;
		const list = byComponent.get(c.componentName) ?? [];
		list.push(c);
		byComponent.set(c.componentName, list);
	}
	const result = [];
	for (const [name, entries] of byComponent) {
		if (unconditional.has(name)) continue;
		result.push(...entries);
	}
	return dedupeCandidates(result);
}
function collectFromConditional(test, consequent, alternate, pathRoots, program, lines, candidates) {
	const consequentComponents = collectComponentsInNode(consequent);
	const alternateComponents = alternate ? collectComponentsInNode(alternate) : /* @__PURE__ */ new Set();
	const pathInfo = analyzePathCondition(test, pathRoots, program);
	for (const name of consequentComponents) {
		if (alternateComponents.has(name)) continue;
		const jsxLoc = findComponentLoc(consequent, name, lines);
		if (!jsxLoc) continue;
		candidates.push({
			componentName: name,
			branch: "consequent",
			jsxLoc,
			pathRootCondition: pathInfo.pathRootCondition,
			routes: pathInfo.routes
		});
	}
	if (!alternate) return;
	for (const name of alternateComponents) {
		if (consequentComponents.has(name)) continue;
		const jsxLoc = findComponentLoc(alternate, name, lines);
		if (!jsxLoc) continue;
		candidates.push({
			componentName: name,
			branch: "alternate",
			jsxLoc,
			pathRootCondition: pathInfo.pathRootCondition,
			routes: pathInfo.routes
		});
	}
}
function collectComponentsInNode(node) {
	const components = /* @__PURE__ */ new Set();
	if (!node) return components;
	walk(node, (n) => {
		const name = getJsxComponentName(n);
		if (name) components.add(name);
	});
	return components;
}
function collectUnconditionalComponents(program, lines) {
	const unconditional = /* @__PURE__ */ new Set();
	walkWithAncestors(program, (node, ancestors) => {
		const name = getJsxComponentName(node);
		if (!name) return;
		if (!isUnderConditionalBranch(ancestors)) unconditional.add(name);
	});
	return unconditional;
}
function isUnderConditionalBranch(ancestors) {
	for (const anc of ancestors) if (anc.type === "IfStatement" || anc.type === "ConditionalExpression") return true;
	return false;
}
function getJsxComponentName(node) {
	if (node.type === "JSXElement") return getJsxTagName(node.openingElement);
	if (node.type === "JSXSelfClosingElement") return getJsxTagName(node);
	return null;
}
function getJsxTagName(node) {
	const name = node.name;
	if (!name) return null;
	if (name.type === "JSXIdentifier") {
		const id = name.name;
		return /^[A-Z]/.test(id) ? id : null;
	}
	if (name.type === "JSXMemberExpression") {
		let current = name;
		while (current.type === "JSXMemberExpression") current = current.object;
		if (current.type === "JSXIdentifier") {
			const id = current.name;
			return /^[A-Z]/.test(id) ? id : null;
		}
	}
	return null;
}
function findComponentLoc(node, componentName, lines) {
	let found = null;
	walk(node, (n) => {
		if (found) return;
		if (getJsxComponentName(n) === componentName) found = locFromSpan(n, lines);
	});
	return found;
}
function collectPathRoots(program) {
	const roots = new Set(PATH_ROOT_NAMES);
	walk(toAst(program), (node) => {
		if (node.type === "VariableDeclarator") {
			const id = node.id;
			const init = node.init;
			if (!init || id.type !== "Identifier") return;
			if (isPathRootInit(init)) roots.add(id.name);
		}
		if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
			const params = node.params ?? [];
			for (const param of params) {
				if (param.type === "Identifier" && PATH_ROOT_NAMES.has(param.name)) roots.add(param.name);
				if (param.type === "ObjectPattern") for (const prop of param.properties ?? []) {
					if (prop.type !== "Property") continue;
					const key = prop.key;
					if (key.type === "Identifier" && PATH_ROOT_NAMES.has(key.name)) {
						const value = prop.value;
						if (value.type === "Identifier") roots.add(value.name);
					}
				}
			}
		}
		if (node.type === "CallExpression") {
			const callee = node.callee;
			if (callee.type === "Identifier" && callee.name === "usePathname") {}
		}
	});
	walk(toAst(program), (node) => {
		if (node.type !== "VariableDeclarator") return;
		const id = node.id;
		const init = node.init;
		if (!init || id.type !== "Identifier") return;
		if (expressionUsesPathRoot(init, roots)) roots.add(id.name);
		if (init.type === "CallExpression") {
			const callee = init.callee;
			if (callee.type === "Identifier" && callee.name === "usePathname") roots.add(id.name);
		}
	});
	return roots;
}
function isPathRootInit(init) {
	if (init.type === "CallExpression") {
		const callee = init.callee;
		return callee.type === "Identifier" && callee.name === "usePathname";
	}
	return false;
}
function expressionUsesPathRoot(node, pathRoots) {
	let uses = false;
	walk(node, (n) => {
		if (uses) return;
		if (n.type === "Identifier" && pathRoots.has(n.name)) uses = true;
	});
	return uses;
}
function analyzePathCondition(test, pathRoots, program) {
	const routes = /* @__PURE__ */ new Set();
	let pathRootCondition = false;
	const visit = (node) => {
		walk(node, (n) => {
			if (n.type === "Identifier" && pathRoots.has(n.name)) pathRootCondition = true;
			const route = stringLiteralRoute(n);
			if (route) routes.add(route);
		});
		if (node.type === "Identifier") {
			const init = findDeclaratorInit(program, node.name);
			if (init) visit(init);
		}
	};
	visit(test);
	return {
		pathRootCondition,
		routes: [...routes]
	};
}
function stringLiteralRoute(node) {
	if (node.type === "Literal" && typeof node.value === "string" && node.value.startsWith("/")) return node.value;
	if (node.type === "StringLiteral" && typeof node.value === "string" && node.value.startsWith("/")) return node.value;
	return null;
}
function findDeclaratorInit(program, name) {
	let init = null;
	walk(toAst(program), (node) => {
		if (init) return;
		if (node.type !== "VariableDeclarator") return;
		const id = node.id;
		if (id.type === "Identifier" && id.name === name) init = node.init ?? null;
	});
	return init;
}
function buildImportedSymbolSet(imports) {
	const symbols = /* @__PURE__ */ new Set();
	for (const imp of imports) {
		if (imp.isDynamic || imp.isTypeOnly) continue;
		for (const sym of imp.namedSymbols) if (sym && sym !== "*") symbols.add(sym);
	}
	return symbols;
}
function dedupeCandidates(candidates) {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const c of candidates) {
		const key = `${c.componentName}:${c.branch}:${c.jsxLoc.line}:${c.jsxLoc.column}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(c);
	}
	return result;
}
function walkWithAncestors(node, visitor, ancestors = []) {
	visitor(node, ancestors);
	for (const key of Object.keys(node)) {
		const val = node[key];
		if (!val || typeof val !== "object") continue;
		if (Array.isArray(val)) {
			for (const child of val) if (child && typeof child === "object" && "type" in child) walkWithAncestors(child, visitor, [...ancestors, node]);
		} else if ("type" in val) walkWithAncestors(val, visitor, [...ancestors, node]);
	}
}
//#endregion
//#region src/rules/loading/branch-exclusive-eager-import.ts
const branchExclusiveEagerImport = {
	id: "branch-exclusive-eager-import",
	category: "loading",
	defaultSeverity: "warning",
	run(ctx) {
		const { dynamicImportMinSubtree } = ctx.config.thresholds;
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			const candidates = analyzeBranchExclusiveComponents(readFileSync(path, "utf-8"), mod.ast(), mod.imports);
			for (const candidate of candidates) {
				const imp = mod.imports.find((i) => !i.isDynamic && !i.isTypeOnly && i.namedSymbols.includes(candidate.componentName));
				if (!imp?.resolvedPath) continue;
				const target = ctx.graph.modules.get(imp.resolvedPath);
				if (!target || target.subtreeBytes < dynamicImportMinSubtree) continue;
				if (isIgnored(ctx, "branch-exclusive-eager-import", path)) continue;
				reportFinding(ctx, {
					id: `${path}:branch-exclusive-eager-import:${candidate.componentName}`,
					ruleId: "branch-exclusive-eager-import",
					category: "loading",
					defaultSeverity: "warning",
					confidence: candidate.pathRootCondition ? "high" : "medium",
					file: path,
					loc: imp.loc,
					message: `'${candidate.componentName}' is only used in one branch of a conditional but statically imported — use next/dynamic`,
					evidence: {
						component: candidate.componentName,
						branch: candidate.branch,
						routes: candidate.routes.length > 0 ? candidate.routes : void 0,
						module: relPath(ctx.projectRoot, imp.resolvedPath),
						subtreeBytes: target.subtreeBytes
					},
					estimatedBytes: target.subtreeBytes,
					fixStrategy: {
						name: "conditional-dynamic",
						steps: [`Replace static import with next/dynamic(() => import('${imp.specifier}'))`, "Add a loading fallback for the branch-exclusive component"]
					}
				});
			}
		}
	}
};
//#endregion
//#region src/analysis/component-registry.ts
const DEFAULT_LITERAL_DOMINANCE_RATIO = .8;
function analyzeComponentRegistries(source, program, imports, options = {}) {
	const literalDominanceRatio = options.literalDominanceRatio ?? DEFAULT_LITERAL_DOMINANCE_RATIO;
	const lines = source.split("\n");
	const importedSymbols = buildImportedSymbolMap(program, imports);
	const localObjects = collectLocalObjectDeclarations(program, lines);
	const exportedNames = collectExportedNames(program);
	const registries = [];
	for (const exportName of exportedNames) {
		const decl = localObjects.get(exportName);
		if (!decl || decl.init?.type !== "ObjectExpression") continue;
		const stats = analyzeObjectExpression(decl.init, importedSymbols);
		if (stats.literalRatio > literalDominanceRatio) continue;
		if (stats.componentEntryCount === 0) continue;
		registries.push({
			exportName,
			loc: decl.loc,
			entryCount: stats.entryCount,
			componentEntryCount: stats.componentEntryCount,
			importedComponentCount: stats.importedComponentCount,
			referencedImportPaths: [...stats.referencedPaths]
		});
	}
	return registries;
}
function analyzeObjectExpression(obj, importedSymbols) {
	const properties = obj.properties ?? [];
	const stats = {
		entryCount: 0,
		componentEntryCount: 0,
		importedComponentCount: 0,
		literalCount: 0,
		literalRatio: 0,
		referencedPaths: /* @__PURE__ */ new Set()
	};
	for (const prop of properties) {
		if (prop.type === "SpreadElement") continue;
		if (prop.type !== "Property") continue;
		stats.entryCount++;
		const value = prop.value;
		const key = prop.key;
		const keyName = key.type === "Identifier" ? key.name : null;
		if (isLiteralValue(value)) {
			stats.literalCount++;
			continue;
		}
		if (!isComponentEntry(prop, value)) continue;
		stats.componentEntryCount++;
		const symbol = resolveComponentSymbol(prop, value, keyName);
		if (symbol && importedSymbols.has(symbol)) {
			stats.importedComponentCount++;
			const path = importedSymbols.get(symbol);
			if (path) stats.referencedPaths.add(path);
		}
	}
	stats.literalRatio = stats.entryCount > 0 ? stats.literalCount / stats.entryCount : 0;
	return stats;
}
function isLiteralValue(value) {
	return value.type === "Literal" || value.type === "StringLiteral" || value.type === "NumericLiteral";
}
function isComponentEntry(prop, value) {
	if (value.type === "Identifier") return true;
	if (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") return containsJsx(value);
	if (prop.method === true && (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression")) return containsJsx(value);
	return false;
}
function resolveComponentSymbol(prop, value, keyName) {
	if (value.type === "Identifier") return value.name;
	if (prop.shorthand === true && keyName) return keyName;
	return null;
}
function containsJsx(node) {
	let found = false;
	walk(node, (n) => {
		if (found) return;
		if (n.type === "JSXElement" || n.type === "JSXFragment") found = true;
	});
	return found;
}
function collectLocalObjectDeclarations(program, lines) {
	const locals = /* @__PURE__ */ new Map();
	const record = (name, init, loc) => {
		locals.set(name, {
			init,
			loc
		});
	};
	for (const stmt of program.body) {
		if (stmt.type === "VariableDeclaration") {
			for (const decl of stmt.declarations) if (decl.id.type === "Identifier") record(decl.id.name, decl.init ? toAst(decl.init) : null, locFromSpan(decl, lines));
		}
		if (stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration") {
			for (const decl of stmt.declaration.declarations) if (decl.id.type === "Identifier") record(decl.id.name, decl.init ? toAst(decl.init) : null, locFromSpan(decl, lines));
		}
	}
	return locals;
}
function collectExportedNames(program) {
	const names = /* @__PURE__ */ new Set();
	for (const stmt of program.body) {
		if (stmt.type === "ExportNamedDeclaration") {
			if (stmt.declaration?.type === "VariableDeclaration") {
				for (const decl of stmt.declaration.declarations) if (decl.id.type === "Identifier") names.add(decl.id.name);
			}
			for (const spec of stmt.specifiers ?? []) {
				const exported = spec.exported?.type === "Identifier" ? spec.exported.name : spec.exported?.type === "Literal" ? String(spec.exported.value) : "";
				const local = spec.local?.type === "Identifier" ? spec.local.name : "";
				names.add(exported || local);
			}
		}
		if (stmt.type === "ExportDefaultDeclaration") {
			const decl = stmt.declaration;
			if (decl?.type === "Identifier") names.add(decl.name);
		}
	}
	return names;
}
function buildImportedSymbolMap(program, imports) {
	const bySpecifier = /* @__PURE__ */ new Map();
	for (const imp of imports) {
		if (imp.isDynamic || imp.isTypeOnly) continue;
		const list = bySpecifier.get(imp.specifier) ?? [];
		list.push(imp);
		bySpecifier.set(imp.specifier, list);
	}
	const map = /* @__PURE__ */ new Map();
	for (const stmt of program.body) {
		if (stmt.type !== "ImportDeclaration") continue;
		const specifier = stmt.source?.value ?? "";
		const resolvedPath = (bySpecifier.get(specifier)?.shift())?.resolvedPath ?? null;
		for (const spec of stmt.specifiers ?? []) {
			if (spec.type === "ImportDefaultSpecifier" && spec.local?.type === "Identifier") map.set(spec.local.name, resolvedPath);
			if (spec.type === "ImportSpecifier" && spec.local?.type === "Identifier") map.set(spec.local.name, resolvedPath);
		}
	}
	return map;
}
//#endregion
//#region src/rules/loading/static-component-map.ts
function isClientRelevant(ctx, filePath) {
	const mod = ctx.graph.modules.get(filePath);
	if (!mod) return false;
	if (ctx.graph.clientModules.has(filePath)) return true;
	if (mod.dependents.some((d) => ctx.graph.clientModules.has(d))) return true;
	return mod.imports.some((imp) => imp.resolvedPath && ctx.graph.clientModules.has(imp.resolvedPath));
}
function sumSubtreeBytes(ctx, paths) {
	let total = 0;
	for (const path of paths) {
		const target = ctx.graph.modules.get(path);
		if (target) total += target.subtreeBytes;
	}
	return total;
}
//#endregion
//#region src/rules/loading/index.ts
const loadingRules = [
	missingDynamicImport,
	branchExclusiveEagerImport,
	{
		id: "static-component-map",
		category: "loading",
		defaultSeverity: "warning",
		run(ctx) {
			const { componentMapMinEntries, componentMapMinImports } = ctx.config.thresholds;
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (!isClientRelevant(ctx, mod.filePath)) continue;
				if (isIgnored(ctx, "static-component-map", mod.filePath)) continue;
				const registries = analyzeComponentRegistries(readFileSync(mod.filePath, "utf-8"), mod.ast(), mod.imports);
				for (const reg of registries) {
					if (reg.componentEntryCount < componentMapMinEntries) continue;
					if (reg.importedComponentCount < componentMapMinImports) continue;
					const subtreeBytes = sumSubtreeBytes(ctx, reg.referencedImportPaths);
					reportFinding(ctx, {
						id: `${mod.filePath}:${reg.exportName}:static-component-map`,
						ruleId: "static-component-map",
						category: "loading",
						defaultSeverity: "warning",
						confidence: "high",
						file: mod.filePath,
						loc: reg.loc,
						message: `Large static component map "${reg.exportName}" eagerly imports ${reg.importedComponentCount} components`,
						evidence: {
							exportName: reg.exportName,
							entryCount: reg.componentEntryCount,
							importedComponentCount: reg.importedComponentCount,
							referencedModules: reg.referencedImportPaths,
							subtreeBytes
						},
						estimatedBytes: subtreeBytes > 0 ? subtreeBytes : void 0,
						fixStrategy: {
							name: "lazy-component-map",
							steps: [
								"Split the registry into per-feature or per-route maps",
								"Replace static imports with dynamic(() => import('./Component')) per entry",
								"Or pass only the components a page needs instead of one global map"
							]
						}
					});
				}
			}
		}
	},
	onDemandFeatureEager,
	nextDynamicMisuse
];
//#endregion
//#region src/rules/index.ts
function getAllRules() {
	return [
		...boundaryRules,
		...dependencyRules,
		...loadingRules
	];
}
//#endregion
//#region src/build/binary-format.ts
function parseDataFile(buf) {
	if (buf.byteLength < 4) throw new Error("analyze data file too small");
	const jsonLength = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
	if (jsonLength <= 0 || 4 + jsonLength > buf.byteLength) throw new Error(`invalid analyze JSON length: ${jsonLength}`);
	const jsonStr = new TextDecoder("utf-8").decode(buf.subarray(4, 4 + jsonLength));
	const header = JSON.parse(jsonStr);
	const binaryOffset = 4 + jsonLength;
	return {
		header,
		binary: new DataView(buf.buffer, buf.byteOffset + binaryOffset, buf.byteLength - binaryOffset)
	};
}
function readEdgesAtIndex(binary, ref, index) {
	if (!ref || ref.length === 0) return [];
	const { offset } = ref;
	if (offset + 4 > binary.byteLength) return [];
	const numOffsets = binary.getUint32(offset, false);
	if (index < 0 || index >= numOffsets) return [];
	const offsetsStart = offset + 4;
	const prevOffset = index === 0 ? 0 : binary.getUint32(offsetsStart + (index - 1) * 4, false);
	const edgeCount = binary.getUint32(offsetsStart + index * 4, false) - prevOffset;
	if (edgeCount <= 0) return [];
	const dataStart = offset + 4 + 4 * numOffsets;
	const edges = [];
	for (let j = 0; j < edgeCount; j++) {
		const pos = dataStart + (prevOffset + j) * 4;
		if (pos + 4 > binary.byteLength) break;
		edges.push(binary.getUint32(pos, false));
	}
	return edges;
}
function buildFullPaths(sources) {
	const cache = /* @__PURE__ */ new Map();
	function getFullPath(index) {
		if (cache.has(index)) return cache.get(index);
		const s = sources[index];
		if (!s) {
			cache.set(index, "");
			return "";
		}
		const p = s.parent_source_index == null ? s.path : getFullPath(s.parent_source_index) + s.path;
		cache.set(index, p);
		return p;
	}
	return sources.map((_, i) => getFullPath(i));
}
//#endregion
//#region src/build/module-path.ts
/** Strip Turbopack virtual prefixes like `[project]/` / `[client-fs]/`. */
function normalizeModulePath$1(raw) {
	if (!raw) return "";
	return raw.replace(/^\[project\]\//, "").replace(/^\[client-fs\]\//, "").replace(/^\[project\]/, "").replace(/^\[client-fs\]/, "").replace(/\\/g, "/");
}
function packageNameFromPath$1(path) {
	const idx = path.lastIndexOf("node_modules/");
	if (idx === -1) return null;
	const rest = path.slice(idx + 13);
	if (rest.startsWith("@")) {
		const parts = rest.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	}
	return rest.split("/")[0] ?? null;
}
//#endregion
//#region src/build/analyze-export.ts
function isClientJavaScriptOutput$1(filename) {
	return filename.startsWith("[client-fs]/") && filename.endsWith(".js");
}
/** Fold graph-v1 JSONL into the route/module byte maps the rest of wimb uses. */
function parseAnalyzeExportJsonl(jsonl) {
	const acc = createExportAccumulator();
	for (const line of jsonl.split("\n")) acc.addLine(line);
	return acc.finish();
}
function parseAnalyzeExportFile(filePath) {
	const buf = readFileSync(filePath);
	return parseAnalyzeExportJsonl(filePath.endsWith(".gz") ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8"));
}
function createExportAccumulator() {
	const routeTotals = /* @__PURE__ */ new Map();
	const perRouteModules = /* @__PURE__ */ new Map();
	let sawPart = false;
	return {
		addLine(line) {
			const trimmed = line.trim();
			if (!trimmed) return;
			let record;
			try {
				record = JSON.parse(trimmed);
			} catch {
				return;
			}
			if (record.type !== "part") return;
			ingestPart$1(record, routeTotals, perRouteModules);
			sawPart = true;
		},
		finish() {
			const routes = /* @__PURE__ */ new Map();
			for (const [route, totals] of routeTotals) routes.set(route, totals.compressed > 0 ? totals.compressed : totals.size);
			const modules = /* @__PURE__ */ new Map();
			for (const routeModules of perRouteModules.values()) for (const [path, bytes] of routeModules) if (bytes > (modules.get(path) ?? 0)) modules.set(path, bytes);
			return {
				routes,
				modules,
				measured: sawPart,
				format: "export"
			};
		}
	};
}
function ingestPart$1(part, routeTotals, perRouteModules) {
	if (!part.route) return;
	const size = numberOrZero$1(part.size);
	const compressed = numberOrZero$1(part.compressed_size);
	const totals = routeTotals.get(part.route) ?? {
		size: 0,
		compressed: 0
	};
	totals.size += size;
	totals.compressed += compressed;
	routeTotals.set(part.route, totals);
	if (!isClientJavaScriptOutput$1(part.filename ?? "")) return;
	const path = normalizeModulePath$1(part.source_path ?? "");
	if (!path) return;
	const bytes = compressed > 0 ? compressed : size;
	addModuleBytes(perRouteModules, part.route, path, bytes);
	const pkg = packageNameFromPath$1(path);
	if (pkg) addModuleBytes(perRouteModules, part.route, pkg, bytes);
}
function addModuleBytes(perRouteModules, route, key, bytes) {
	let routeModules = perRouteModules.get(route);
	if (!routeModules) {
		routeModules = /* @__PURE__ */ new Map();
		perRouteModules.set(route, routeModules);
	}
	routeModules.set(key, (routeModules.get(key) ?? 0) + bytes);
}
function numberOrZero$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
//#endregion
//#region src/build/analyze.ts
/** Snapshot name wimb writes when it runs `next analyze` itself. */
const WIMB_SNAPSHOT = "wimb";
function resolveDistDir(projectRoot, distDirName, flag) {
	if (flag) return join(projectRoot, flag);
	return join(projectRoot, distDirName ?? ".next");
}
/** Locate analyze artifacts under distDir (binary data/ preferred). */
function resolveAnalyzeDirs(distDir) {
	const analyzeDir = join(distDir, "diagnostics", "analyze");
	const dataDir = join(analyzeDir, "data");
	return {
		analyzeDir,
		dataDir: existsSync(dataDir) ? dataDir : null
	};
}
function hasAnalyzeArtifacts(distDir) {
	const { analyzeDir, dataDir } = resolveAnalyzeDirs(distDir);
	if (existsSync(join(analyzeDir, "history", "history.json"))) return true;
	if (dataDir && (existsSync(join(dataDir, "modules.data")) || discoverRouteAnalyzeFiles(dataDir).length > 0)) return true;
	if (!existsSync(analyzeDir)) return false;
	return readdirSync(analyzeDir).some((f) => f.endsWith(".json"));
}
function projectSupportsAnalyzeExport(projectRoot) {
	return existsSync(join(projectRoot, "node_modules", "next", "analyze", "graph-v1.schema.json"));
}
async function runBuildAnalysis(opts) {
	if (opts.analyzeExportPath) return readExportFile(opts.analyzeExportPath);
	const distDir = opts.distDir ?? resolveDistDir(opts.projectRoot);
	const { analyzeDir, dataDir } = resolveAnalyzeDirs(distDir);
	const canExport = projectSupportsAnalyzeExport(opts.projectRoot);
	let capturedSnapshot;
	if (!opts.skipBuild && !hasAnalyzeArtifacts(distDir)) capturedSnapshot = captureAnalyze(opts.projectRoot, canExport, opts.snapshot);
	if (canExport) {
		const snapshot = opts.snapshot ?? capturedSnapshot;
		const exported = await exportAnalyzeGraph(opts.projectRoot, distDir, snapshot);
		if (exported && (exported.routes.size > 0 || exported.modules.size > 0)) {
			console.log("wimb: measured bytes from next analyze export");
			return exported;
		}
	}
	const resolvedDataDir = resolveAnalyzeDirs(distDir).dataDir;
	if (resolvedDataDir) try {
		const attribution = parseBinaryAnalyzeDir(resolvedDataDir);
		if (attribution.routes.size > 0 || attribution.modules.size > 0) {
			console.log("wimb: measured bytes from binary analyze artifacts");
			return attribution;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`wimb: failed to parse binary analyze data (${message}); trying legacy formats`);
	}
	if (existsSync(analyzeDir)) {
		const legacy = parseLegacyJsonAnalyzeDir(analyzeDir);
		if (legacy.routes.size > 0 || legacy.modules.size > 0) {
			console.log("wimb: measured bytes from legacy JSON analyze files");
			return legacy;
		}
	}
	const statsPath = join(distDir, "server", "webpack-stats.json");
	if (existsSync(statsPath)) {
		console.log("wimb: measured bytes from webpack stats");
		return parseWebpackStats(statsPath);
	}
	console.error(`wimb: analyze artifacts not found at ${dataDir ?? analyzeDir}. Run 'next analyze --output' (Next 16.4+) or 'next experimental-analyze --output', or pass --analyze-export.`);
	return null;
}
function readExportFile(filePath) {
	if (!existsSync(filePath)) {
		console.error(`wimb: analyze export not found at ${filePath}`);
		return null;
	}
	const attribution = parseAnalyzeExportFile(filePath);
	if (attribution.routes.size === 0 && attribution.modules.size === 0) {
		console.error(`wimb: no part records in ${filePath}`);
		return null;
	}
	console.log("wimb: measured bytes from next analyze export");
	return attribution;
}
/** Returns the snapshot name written by this capture, when Next 16.4+ was used. */
function captureAnalyze(projectRoot, canExport, snapshot) {
	const name = canExport ? snapshot ?? WIMB_SNAPSHOT : void 0;
	const args = canExport ? [
		"analyze",
		"--output",
		"--snapshot",
		name
	] : ["experimental-analyze", "--output"];
	try {
		const { command, args: fullArgs } = nextCommand(projectRoot, args);
		execFileSync(command, fullArgs, {
			cwd: projectRoot,
			stdio: "inherit",
			env: {
				...process.env,
				TURBOPACK: "1",
				TURBOPACK_STATS: "1"
			}
		});
		return name;
	} catch {
		return;
	}
}
function exportAnalyzeGraph(projectRoot, distDir, snapshot) {
	const args = [
		"analyze",
		"export",
		"--dist-dir",
		distDir
	];
	if (snapshot) args.push("--snapshot", snapshot);
	const { command, args: fullArgs } = nextCommand(projectRoot, args);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const child = spawn(command, fullArgs, {
			cwd: projectRoot,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				TURBOPACK: "1"
			}
		});
		const acc = createExportAccumulator();
		let pending = "";
		let stderr = "";
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk) => {
			pending += chunk;
			let nl = pending.indexOf("\n");
			while (nl !== -1) {
				acc.addLine(pending.slice(0, nl));
				pending = pending.slice(nl + 1);
				nl = pending.indexOf("\n");
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-4e3);
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => {
			if (pending) acc.addLine(pending);
			if (code !== 0) {
				const tail = stderr.trim();
				if (tail) console.error(`wimb: next analyze export failed; falling back to on-disk artifacts\n${tail}`);
				finish(null);
				return;
			}
			finish(acc.finish());
		});
	});
}
function nextCommand(projectRoot, args) {
	const local = join(projectRoot, "node_modules", ".bin", "next");
	if (existsSync(local)) return {
		command: local,
		args
	};
	return {
		command: "npx",
		args: ["next", ...args]
	};
}
/**
* Parse Next.js Turbopack binary analyze output under `.next/diagnostics/analyze/data/`.
*/
function parseBinaryAnalyzeDir(dataDir) {
	const routes = /* @__PURE__ */ new Map();
	const modules = /* @__PURE__ */ new Map();
	const modulesPath = join(dataDir, "modules.data");
	if (existsSync(modulesPath)) try {
		const { header } = parseDataFile(readFileSync(modulesPath));
		for (const mod of header.modules ?? []) {
			const path = normalizeModulePath$1(mod.path ?? mod.ident ?? "");
			if (path && !modules.has(path)) modules.set(path, 0);
		}
	} catch {}
	const routeFiles = discoverRouteAnalyzeFiles(dataDir);
	for (const { route, filePath } of routeFiles) try {
		const { header, binary } = parseDataFile(readFileSync(filePath));
		const attribution = attributeRoute$1(header, binary);
		routes.set(route, attribution.routeCompressedBytes || attribution.routeBytes);
		for (const [path, bytes] of attribution.modules) if (bytes > (modules.get(path) ?? 0)) modules.set(path, bytes);
	} catch {}
	const routesJson = join(dataDir, "routes.json");
	if (existsSync(routesJson)) try {
		const listed = JSON.parse(readFileSync(routesJson, "utf-8"));
		for (const route of listed) if (!routes.has(route)) routes.set(route, 0);
	} catch {}
	return {
		routes,
		modules,
		measured: true,
		format: "binary"
	};
}
function attributeRoute$1(header, binary) {
	const sources = header.sources ?? [];
	const chunkParts = header.chunk_parts ?? [];
	const outputFiles = header.output_files ?? [];
	const fullPaths = buildFullPaths(sources);
	const modules = /* @__PURE__ */ new Map();
	let routeBytes = 0;
	let routeCompressedBytes = 0;
	for (let i = 0; i < sources.length; i++) {
		const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
		if (partIndices.length === 0) continue;
		let size = 0;
		let compressed = 0;
		let clientSize = 0;
		let clientCompressed = 0;
		for (const cpIdx of partIndices) {
			const cp = chunkParts[cpIdx];
			if (!cp) continue;
			size += cp.size;
			compressed += cp.compressed_size;
			const of = outputFiles[cp.output_file_index];
			if (of?.filename.startsWith("[client-fs]/") && of.filename.endsWith(".js")) {
				clientSize += cp.size;
				clientCompressed += cp.compressed_size;
			}
		}
		routeBytes += size;
		routeCompressedBytes += compressed;
		if (clientSize === 0 && clientCompressed === 0) continue;
		const path = normalizeModulePath$1(fullPaths[i] ?? sources[i]?.path ?? "");
		if (!path) continue;
		const bytes = clientCompressed > 0 ? clientCompressed : clientSize;
		modules.set(path, (modules.get(path) ?? 0) + bytes);
		const pkg = packageNameFromPath$1(path);
		if (pkg) modules.set(pkg, (modules.get(pkg) ?? 0) + bytes);
	}
	if (modules.size === 0) for (let i = 0; i < sources.length; i++) {
		const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
		if (partIndices.length === 0) continue;
		let size = 0;
		let compressed = 0;
		for (const cpIdx of partIndices) {
			const cp = chunkParts[cpIdx];
			if (!cp) continue;
			size += cp.size;
			compressed += cp.compressed_size;
		}
		const path = normalizeModulePath$1(fullPaths[i] ?? "");
		if (!path) continue;
		const bytes = compressed > 0 ? compressed : size;
		modules.set(path, (modules.get(path) ?? 0) + bytes);
		const pkg = packageNameFromPath$1(path);
		if (pkg) modules.set(pkg, (modules.get(pkg) ?? 0) + bytes);
	}
	return {
		routeBytes,
		routeCompressedBytes,
		modules
	};
}
function discoverRouteAnalyzeFiles(dataDir) {
	const routes = [];
	function walk(dir, routePrefix) {
		const analyzeFile = join(dir, "analyze.data");
		if (existsSync(analyzeFile)) routes.push({
			route: routePrefix || "/",
			filePath: analyzeFile
		});
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			if (entry === "analyze.data" || entry === "modules.data" || entry === "routes.json") continue;
			const full = join(dir, entry);
			try {
				if (statSync(full).isDirectory()) walk(full, `${routePrefix}/${entry}`.replace(/\/+/g, "/") || "/");
			} catch {}
		}
	}
	walk(dataDir, "");
	return routes;
}
function parseLegacyJsonAnalyzeDir(dir) {
	const routes = /* @__PURE__ */ new Map();
	const modules = /* @__PURE__ */ new Map();
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
			if (data.route && data.size) routes.set(data.route, data.size);
			if (data.modules) for (const m of data.modules) modules.set(m.name, m.size);
		} catch {}
	}
	return {
		routes,
		modules,
		measured: true,
		format: "legacy-json"
	};
}
function parseWebpackStats(path) {
	const routes = /* @__PURE__ */ new Map();
	const modules = /* @__PURE__ */ new Map();
	try {
		const stats = JSON.parse(readFileSync(path, "utf-8"));
		for (const chunk of stats.chunks ?? []) {
			const name = chunk.names?.[0] ?? "unknown";
			routes.set(name, (routes.get(name) ?? 0) + (chunk.size ?? 0));
		}
		for (const mod of stats.modules ?? []) if (mod.name) modules.set(mod.name, mod.size ?? 0);
	} catch {}
	return {
		routes,
		modules,
		measured: true,
		format: "webpack-stats"
	};
}
//#endregion
//#region src/paths.ts
const WIMB_OUTPUT_DIR = ".wimb";
function resolveOutputDir(projectRoot) {
	return join(projectRoot, WIMB_OUTPUT_DIR);
}
//#endregion
//#region src/report/markdown.ts
const SEVERITY_SECTIONS = [
	"error",
	"warning",
	"info"
];
function toMarkdown(report) {
	const lines = [
		"# WIMB Report — Where Is My Banana",
		"",
		`**Mode:** ${report.mode} | **Findings:** ${report.summary.total} | **${report.summary.byteSource === "measured" ? "Measured" : "Est."} client bytes:** ${formatBytes$1(report.summary.estimatedClientBytes)}`,
		"",
		"## Summary",
		"",
		`| Severity | Count |`,
		`|----------|-------|`,
		`| Error | ${report.summary.bySeverity.error} |`,
		`| Warning | ${report.summary.bySeverity.warning} |`,
		`| Info | ${report.summary.bySeverity.info} |`,
		""
	];
	for (const severity of SEVERITY_SECTIONS) {
		const group = report.findings.filter((f) => f.severity === severity);
		if (group.length === 0) continue;
		lines.push(`## ${severityLabel(severity)} (${group.length})`);
		lines.push("");
		for (const f of group) appendFinding(lines, f);
	}
	return lines.join("\n");
}
function appendFinding(lines, f) {
	lines.push(`### [${f.severity}] ${f.ruleId}`);
	lines.push("");
	lines.push(`**File:** \`${f.file}\`${f.loc ? ` (line ${f.loc.line})` : ""}`);
	lines.push(`**Confidence:** ${f.confidence}`);
	if (f.estimatedBytes) {
		const label = f.byteSource === "measured" ? "Measured bytes" : "Est. bytes";
		lines.push(`**${label}:** ${formatBytes$1(f.estimatedBytes)}`);
	}
	lines.push("");
	lines.push(f.message);
	lines.push("");
	lines.push("**Fix:**");
	for (const step of f.fixStrategy.steps) lines.push(`- ${step}`);
	lines.push("");
}
function severityLabel(severity) {
	if (severity === "error") return "Errors";
	if (severity === "warning") return "Warnings";
	return "Info";
}
function formatBytes$1(n) {
	if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}
//#endregion
//#region src/report/index.ts
const SEVERITY_ORDER = {
	error: 3,
	warning: 2,
	info: 1
};
function buildReport(projectRoot, mode, findings, opts) {
	const bySeverity = {
		error: 0,
		warning: 0,
		info: 0
	};
	const byCategory = {};
	const byteKeys = /* @__PURE__ */ new Map();
	let anyMeasured = false;
	for (const f of findings) {
		bySeverity[f.severity]++;
		byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
		if (f.byteSource === "measured") anyMeasured = true;
		if (f.estimatedBytes == null) continue;
		const key = byteDedupeKey(f);
		const prev = byteKeys.get(key) ?? 0;
		byteKeys.set(key, Math.max(prev, f.estimatedBytes));
	}
	const estimatedClientBytes = [...byteKeys.values()].reduce((sum, n) => sum + n, 0);
	const byteSource = opts?.byteSource ?? (anyMeasured ? "measured" : "estimated");
	return {
		version: "1.0.0",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		projectRoot,
		mode,
		findings: findings.sort((a, b) => (b.estimatedBytes ?? 0) - (a.estimatedBytes ?? 0) || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]),
		summary: {
			total: findings.length,
			bySeverity,
			byCategory,
			estimatedClientBytes,
			byteSource
		}
	};
}
function writeReports(projectRoot, report, formats) {
	const outputDir = resolveOutputDir(projectRoot);
	mkdirSync(outputDir, { recursive: true });
	if (formats.has("json") || formats.size === 0) writeFileSync(join(outputDir, "wimb-report.json"), JSON.stringify(report, null, 2));
	if (formats.has("md") || formats.size === 0) writeFileSync(join(outputDir, "wimb-report.md"), toMarkdown(report));
}
function exitCodeForReport(report, threshold = "error") {
	const thresholdLevel = SEVERITY_ORDER[threshold];
	return report.findings.some((f) => SEVERITY_ORDER[f.severity] >= thresholdLevel) ? 1 : 0;
}
function byteDedupeKey(f) {
	const { package: pkg, module: mod } = f.evidence;
	if (typeof pkg === "string" && pkg) return pkg;
	if (typeof mod === "string" && mod) return mod;
	return `${f.ruleId}:${f.file}`;
}
//#endregion
//#region src/report/terminal.ts
const SEVERITY_WIDTH = 7;
function formatFindingsForTerminal(report) {
	const lines = [];
	for (const f of report.findings) {
		const loc = f.loc ? `:${f.loc.line}` : "";
		const bytes = f.estimatedBytes != null && f.estimatedBytes > 0 ? ` (${formatBytes(f.estimatedBytes)})` : "";
		lines.push(`${f.severity.padEnd(SEVERITY_WIDTH)} ${f.ruleId}  ${f.file}${loc}${bytes}`);
		lines.push(`       ${f.message}`);
		if (f.fixStrategy.steps.length > 0) lines.push(`       → ${f.fixStrategy.steps[0]}`);
		lines.push("");
	}
	return lines.join("\n").replace(/\n$/, "");
}
function printFindingsToTerminal(report) {
	if (report.findings.length === 0) return;
	console.log(formatFindingsForTerminal(report));
}
function formatBytes(n) {
	if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}
//#endregion
//#region src/forest/routes.ts
const APP_ROOTS = ["app", "src/app"];
const PAGE_RE = /\/page\.(t|j)sx?$/;
const LAYOUT_NAMES = [
	"layout.tsx",
	"layout.ts",
	"layout.jsx",
	"layout.js"
];
function findPageFiles(projectRoot) {
	const pages = [];
	for (const root of APP_ROOTS) {
		const full = join(projectRoot, root);
		if (!existsSync(full) || !statSync(full).isDirectory()) continue;
		walkForPages(full, projectRoot, pages);
	}
	return pages.sort();
}
function walkForPages(dir, projectRoot, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			walkForPages(path, projectRoot, out);
		} else if (PAGE_RE.test(path)) out.push(relative(projectRoot, path));
	}
}
function filePathToRoute(pageFile) {
	let routePath = pageFile.replace(/\\/g, "/");
	for (const root of APP_ROOTS) if (routePath.startsWith(`${root}/`)) {
		routePath = routePath.slice(root.length + 1);
		break;
	}
	routePath = routePath.replace(/\/?page\.(t|j)sx?$/, "");
	if (!routePath) return "/";
	const segments = routePath.split("/").filter((segment) => {
		if (!segment) return false;
		if (segment.startsWith("(") && segment.endsWith(")")) return false;
		return true;
	});
	return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
function resolveLayoutChain(pageFile, projectRoot) {
	const absPage = resolve(projectRoot, pageFile);
	const appRoot = findAppRoot(absPage, projectRoot);
	if (!appRoot) return [];
	const layouts = [];
	let walkDir = dirname(absPage);
	while (walkDir.startsWith(appRoot)) {
		for (const name of LAYOUT_NAMES) {
			const candidate = join(walkDir, name);
			if (existsSync(candidate)) {
				const rel = relative(projectRoot, candidate);
				if (!layouts.includes(rel)) layouts.unshift(rel);
				break;
			}
		}
		if (walkDir === appRoot) break;
		walkDir = dirname(walkDir);
	}
	return layouts;
}
function findAppRoot(absPage, projectRoot) {
	for (const root of APP_ROOTS) {
		const full = resolve(projectRoot, root);
		if (absPage.startsWith(full + "/") || dirname(absPage) === full) return full;
	}
	return null;
}
function entryFilesForPage(pageFile, projectRoot) {
	const entries = [...resolveLayoutChain(pageFile, projectRoot)];
	if (!entries.includes(pageFile)) entries.push(pageFile);
	return entries;
}
//#endregion
//#region src/forest/serialize-ast.ts
const MAX_DEPTH = 12;
const MAX_ARRAY_LENGTH = 64;
const MAX_STRING_LENGTH = 256;
const SKIP_KEYS = new Set([
	"span",
	"start",
	"end",
	"hash",
	"parent",
	"range",
	"loc",
	"raw",
	"extra",
	"cooked"
]);
const SHALLOW_BODY_TYPES = new Set([
	"BlockStatement",
	"ClassBody",
	"SwitchCase",
	"CatchClause"
]);
function serializeAst(program, source) {
	const lines = source.split("\n");
	const bodyNodes = program.body.map((stmt) => toAst(stmt));
	const body = serializeNodes(bodyNodes, lines, 0);
	const truncated = body.length < bodyNodes.length;
	return {
		type: "Program",
		sourceType: program.sourceType === "script" ? "script" : "module",
		body,
		...truncated ? { truncated: true } : {}
	};
}
function serializeNodes(nodes, lines, depth) {
	const limit = Math.min(nodes.length, MAX_ARRAY_LENGTH);
	const out = [];
	for (let i = 0; i < limit; i++) out.push(serializeNode(nodes[i], lines, depth));
	return out;
}
function serializeNode(node, lines, depth) {
	const result = { type: node.type };
	try {
		result.loc = locFromSpan(node, lines);
	} catch {}
	if (depth >= MAX_DEPTH) return result;
	if (node.type === "Literal" || node.type === "StringLiteral") {
		const value = node.value;
		if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
			result.value = `[truncated ${value.length} chars]`;
			result.truncated = true;
			return result;
		}
	}
	for (const [key, value] of Object.entries(node)) {
		if (SKIP_KEYS.has(key) || key === "type") continue;
		if (key === "body" && SHALLOW_BODY_TYPES.has(node.type)) {
			const body = value;
			if (Array.isArray(body)) {
				const shallow = body.filter((stmt) => stmt.type === "ReturnStatement" || stmt.type === "ImportDeclaration").slice(0, 8);
				if (shallow.length > 0) result.body = serializeNodes(shallow, lines, depth + 1);
				else result.bodyOmitted = true;
			}
			continue;
		}
		const serialized = serializeValue(value, lines, depth + 1);
		if (serialized !== void 0) result[key] = serialized;
	}
	return result;
}
function serializeValue(value, lines, depth) {
	if (value == null) return null;
	if (typeof value === "string") return truncateString(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const limit = Math.min(value.length, MAX_ARRAY_LENGTH);
		const out = [];
		for (let i = 0; i < limit; i++) {
			const item = value[i];
			if (item && typeof item === "object" && "type" in item) out.push(serializeNode(item, lines, depth));
		}
		return out;
	}
	if (typeof value === "object" && "type" in value) return serializeNode(value, lines, depth);
}
function truncateString(value) {
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length} chars]`;
}
function sliceSource(source, loc) {
	const lines = source.split("\n");
	if (loc.endLine != null && loc.endLine !== loc.line) {
		const startLine = lines[loc.line - 1] ?? "";
		const endLine = lines[loc.endLine - 1] ?? "";
		if (loc.line === loc.endLine) return truncateString(startLine.slice(loc.column - 1, loc.endColumn != null ? loc.endColumn - 1 : void 0));
		const parts = [startLine.slice(loc.column - 1)];
		for (let i = loc.line; i < loc.endLine - 1; i++) parts.push(lines[i] ?? "");
		parts.push(endLine.slice(0, loc.endColumn != null ? loc.endColumn - 1 : void 0));
		return truncateString(parts.join("\n"));
	}
	return truncateString((lines[loc.line - 1] ?? "").slice(loc.column - 1, loc.endColumn != null ? loc.endColumn - 1 : void 0));
}
//#endregion
//#region src/forest/builder.ts
/** Auto-omit AST when a project has many routes (AST dominates forest.json size/time). */
const AUTO_COMPACT_PAGE_THRESHOLD = 15;
/** Omit nested forest trees + global modules map (pages[].imports remains). */
const AUTO_SLIM_PAGE_THRESHOLD = 15;
const SLIM_MAX_IMPORTS_PER_PAGE = 500;
function moduleEnvToForestRuntime(env) {
	if (env === "shared") return "both";
	return env;
}
function buildForestReport(projectRoot, graph, byteAttribution, options) {
	const entries = /* @__PURE__ */ new Map();
	const modules = /* @__PURE__ */ new Map();
	const pages = [];
	const pageFiles = findPageFiles(projectRoot);
	const sourceCache = /* @__PURE__ */ new Map();
	const compact = options?.compact ?? (pageFiles.length > AUTO_COMPACT_PAGE_THRESHOLD ? true : false);
	const slim = options?.slim ?? (pageFiles.length > AUTO_SLIM_PAGE_THRESHOLD ? true : false);
	const verbose = options?.verbose ?? false;
	if (compact && options?.compact !== true && pageFiles.length > AUTO_COMPACT_PAGE_THRESHOLD) console.log(`wimb: forest.json omitting AST (${pageFiles.length} pages — large project)`);
	if (slim && options?.slim !== true && pageFiles.length > AUTO_SLIM_PAGE_THRESHOLD) console.log(`wimb: forest.json slim mode (${pageFiles.length} pages — nested trees and modules map omitted)`);
	const reportCtx = {
		projectRoot,
		graph,
		byteAttribution: byteAttribution ?? null,
		conditionalByImporter: buildGlobalConditionalUsageMap(projectRoot, graph, sourceCache),
		heavySubtreeThreshold: options?.heavySubtreeThreshold ?? DEFAULT_CONFIG.thresholds.dynamicImportMinSubtree,
		compact,
		slim,
		verbose,
		sourceCache
	};
	for (let i = 0; i < pageFiles.length; i++) {
		const pageFile = pageFiles[i];
		if (verbose && (i === 0 || (i + 1) % 5 === 0 || i === pageFiles.length - 1)) console.log(`wimb: forest ${i + 1}/${pageFiles.length} ${filePathToRoute(pageFile)}`);
		pages.push(buildForestPage(pageFile, entries, modules, reportCtx, slim));
	}
	return {
		version: "1.1.0",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		projectRoot,
		entries: slim ? {} : Object.fromEntries(entries),
		modules: slim ? {} : Object.fromEntries(modules),
		pages
	};
}
function stubForestNode(pageFile, graph, projectRoot) {
	const abs = resolve(projectRoot, pageFile);
	const mod = graph.modules.get(abs);
	return {
		file: pageFile,
		runtime: mod ? moduleEnvToForestRuntime(mod.env) : "server",
		isBoundary: mod?.isBoundary ?? false,
		directives: mod ? [...mod.directives] : [],
		sourceBytes: mod?.sourceBytes ?? 0,
		subtreeBytes: mod?.subtreeBytes ?? 0,
		packageName: packageNameForModule(abs, projectRoot),
		imports: []
	};
}
function writeForestReport(projectRoot, graph, byteAttribution, options) {
	const report = buildForestReport(projectRoot, graph, byteAttribution, options);
	const outputDir = resolveOutputDir(projectRoot);
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(join(outputDir, "forest.json"), JSON.stringify(report));
	if (!byteAttribution) console.log("wimb: run with --build for real client bundle sizes (bundleBytes)");
	return report;
}
function buildForestPage(pageFile, entries, modules, reportCtx, slim) {
	const { projectRoot, graph, byteAttribution } = reportCtx;
	const route = filePathToRoute(pageFile);
	const layoutFiles = resolveLayoutChain(pageFile, projectRoot);
	const entryFiles = entryFilesForPage(pageFile, projectRoot);
	const reachable = /* @__PURE__ */ new Set();
	for (const file of entryFiles) {
		const role = file === pageFile ? "page" : "layout";
		if (!reportCtx.slim) ensureForestEntry(file, projectRoot, graph, role, entries, reportCtx.compact);
		walkModule$1(resolve(projectRoot, file), projectRoot, graph, modules, reachable, byteAttribution, !slim);
	}
	const clientReachable = computeClientReachableFiles(projectRoot, graph, reachable);
	const importChains = buildImportChainIndex(entryFiles, reachable, projectRoot, graph);
	const ctx = {
		...reportCtx,
		entryFiles,
		reachable,
		clientReachable,
		importChains
	};
	const forest = slim ? stubForestNode(pageFile, graph, projectRoot) : buildPageForest(ctx);
	const imports = buildPageImports(ctx);
	const lazyImports = buildLazyImports(ctx);
	const subtreeBytes = [...reachable].reduce((sum, rel) => {
		const abs = resolve(projectRoot, rel);
		return sum + (graph.modules.get(abs)?.sourceBytes ?? 0);
	}, 0);
	const page = {
		route,
		pageFile,
		layoutFiles,
		entryFiles,
		roots: entryFiles,
		reachableFiles: [...reachable].sort(),
		clientReachableFiles: [...clientReachable].sort(),
		imports,
		lazyImports,
		forest,
		subtreeBytes
	};
	if (byteAttribution?.routes.has(route)) page.bundleBytes = byteAttribution.routes.get(route);
	return page;
}
function computeClientReachableFiles(projectRoot, graph, reachable) {
	const clientReachable = /* @__PURE__ */ new Set();
	const queue = [];
	for (const rel of reachable) {
		const mod = graph.modules.get(resolve(projectRoot, rel));
		if (!mod) continue;
		if (mod.isBoundary || mod.directives.has("client-only")) {
			clientReachable.add(rel);
			queue.push(rel);
		}
	}
	while (queue.length > 0) {
		const rel = queue.shift();
		const mod = graph.modules.get(resolve(projectRoot, rel));
		if (!mod) continue;
		for (const imp of mod.imports) {
			if (imp.isDynamic || !imp.resolvedPath) continue;
			const childRel = relative(projectRoot, imp.resolvedPath);
			if (!reachable.has(childRel) || clientReachable.has(childRel)) continue;
			clientReachable.add(childRel);
			queue.push(childRel);
		}
	}
	return clientReachable;
}
function buildGlobalConditionalUsageMap(projectRoot, graph, sourceCache) {
	const byImporter = /* @__PURE__ */ new Map();
	for (const path of graph.clientModules) {
		const rel = relative(projectRoot, path);
		if (rel.startsWith("..")) continue;
		const mod = graph.modules.get(path);
		if (!mod) continue;
		const candidates = analyzeBranchExclusiveComponents(getSource(path, sourceCache), mod.ast(), mod.imports);
		if (candidates.length === 0) continue;
		const symbolMap = /* @__PURE__ */ new Map();
		for (const c of candidates) symbolMap.set(c.componentName, c);
		byImporter.set(rel, symbolMap);
	}
	return byImporter;
}
function buildImportChainIndex(entryFiles, reachable, projectRoot, graph) {
	const chains = /* @__PURE__ */ new Map();
	for (const entry of entryFiles) chains.set(entry, [entry]);
	const queue = [...entryFiles];
	const visited = /* @__PURE__ */ new Set();
	while (queue.length > 0) {
		const file = queue.shift();
		if (visited.has(file)) continue;
		visited.add(file);
		const chain = chains.get(file) ?? [file];
		const mod = graph.modules.get(resolve(projectRoot, file));
		if (!mod) continue;
		for (const imp of mod.imports) {
			if (!imp.resolvedPath || imp.isTypeOnly) continue;
			const childRel = relative(projectRoot, imp.resolvedPath);
			if (!reachable.has(childRel) || chains.has(childRel)) continue;
			chains.set(childRel, [...chain, childRel]);
			queue.push(childRel);
		}
	}
	return chains;
}
function buildPageForest(ctx) {
	const rootFile = ctx.entryFiles[0];
	const rootNode = buildForestNode(rootFile, ctx, /* @__PURE__ */ new Set());
	const inTree = collectFilesInTree(rootNode);
	for (const entry of ctx.entryFiles.slice(1)) {
		if (inTree.has(entry)) continue;
		const entryNode = buildForestNode(entry, ctx, /* @__PURE__ */ new Set());
		rootNode.imports.push(createEntryLink(entry, entryNode, ctx));
	}
	return rootNode;
}
function createEntryLink(entryFile, child, ctx) {
	const abs = resolve(ctx.projectRoot, entryFile);
	const mod = ctx.graph.modules.get(abs);
	return enrichImportNode(toImportEdge({
		specifier: entryFile,
		resolvedPath: abs,
		packageName: null,
		namedSymbols: ["default"],
		isDynamic: false,
		isTypeOnly: false,
		loc: {
			line: 1,
			column: 0
		}
	}, ctx.projectRoot, ctx.graph, ctx.byteAttribution), entryFile, entryFile, mod, ctx, null);
}
function buildForestNode(relFile, ctx, visited) {
	const abs = resolve(ctx.projectRoot, relFile);
	const mod = ctx.graph.modules.get(abs);
	const node = {
		file: relFile,
		runtime: mod ? moduleEnvToForestRuntime(mod.env) : "server",
		isBoundary: mod?.isBoundary ?? false,
		directives: mod ? [...mod.directives] : [],
		sourceBytes: mod?.sourceBytes ?? 0,
		subtreeBytes: mod?.subtreeBytes ?? 0,
		packageName: packageNameForModule(abs, ctx.projectRoot),
		imports: []
	};
	if (!mod || visited.has(relFile)) return node;
	visited.add(relFile);
	for (const imp of mod.imports) {
		const edge = toImportEdge(imp, ctx.projectRoot, ctx.graph, ctx.byteAttribution);
		const resolvedRel = imp.resolvedPath ? relative(ctx.projectRoot, imp.resolvedPath) : null;
		const childMod = imp.resolvedPath ? ctx.graph.modules.get(imp.resolvedPath) : void 0;
		let child = null;
		if (!imp.isTypeOnly && !imp.isDynamic && resolvedRel && !visited.has(resolvedRel)) child = buildForestNode(resolvedRel, ctx, visited);
		node.imports.push(enrichImportNode(edge, relFile, resolvedRel, childMod, ctx, child));
	}
	return node;
}
function enrichImportNode(edge, importerFile, resolvedFile, targetMod, ctx, child) {
	const loadKind = loadKindForImport(edge);
	const usage = resolveUsage(importerFile, edge, ctx);
	const hints = buildHints(loadKind, usage, resolvedFile, edge, targetMod, ctx);
	return {
		...edge,
		loadKind,
		usage,
		hints,
		child
	};
}
function buildPageImports(ctx) {
	const byTarget = /* @__PURE__ */ new Map();
	for (const rel of ctx.reachable) {
		const abs = resolve(ctx.projectRoot, rel);
		const mod = ctx.graph.modules.get(abs);
		if (!mod) continue;
		for (const imp of mod.imports) {
			const edge = toImportEdge(imp, ctx.projectRoot, ctx.graph, ctx.byteAttribution);
			const loadKind = loadKindForImport(edge);
			const resolvedRel = imp.resolvedPath ? relative(ctx.projectRoot, imp.resolvedPath) : null;
			const targetKey = `${resolvedRel ?? edge.specifier}|${loadKind}`;
			const targetMod = imp.resolvedPath ? ctx.graph.modules.get(imp.resolvedPath) : void 0;
			const usage = resolveUsage(rel, edge, ctx);
			const hints = buildHints(loadKind, usage, resolvedRel, edge, targetMod, ctx);
			const runtime = targetMod ? moduleEnvToForestRuntime(targetMod.env) : resolvedRel && ctx.clientReachable.has(resolvedRel) ? "client" : "server";
			const row = {
				resolvedFile: resolvedRel,
				specifier: edge.specifier,
				namedSymbols: edge.namedSymbols,
				loadKind,
				usage,
				runtime,
				isBoundary: targetMod?.isBoundary ?? false,
				directives: targetMod ? [...targetMod.directives] : [],
				importerFile: rel,
				importChain: ctx.importChains.get(resolvedRel ?? rel) ?? [resolvedRel ?? rel],
				sourceBytes: edge.sourceBytes,
				subtreeBytes: edge.subtreeBytes,
				bundleBytes: edge.bundleBytes,
				packageName: edge.packageName,
				signals: ctx.slim ? void 0 : targetMod ? signalSummary(targetMod) : void 0,
				hints
			};
			const existing = byTarget.get(targetKey);
			if (!existing || (row.subtreeBytes ?? 0) > (existing.subtreeBytes ?? 0)) byTarget.set(targetKey, row);
		}
	}
	let rows = [...byTarget.values()].sort((a, b) => {
		const aBytes = a.subtreeBytes ?? -1;
		return (b.subtreeBytes ?? -1) - aBytes;
	});
	if (ctx.slim && rows.length > SLIM_MAX_IMPORTS_PER_PAGE) rows = rows.slice(0, SLIM_MAX_IMPORTS_PER_PAGE);
	return rows;
}
function buildLazyImports(ctx) {
	const lazy = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rel of ctx.reachable) {
		const abs = resolve(ctx.projectRoot, rel);
		const mod = ctx.graph.modules.get(abs);
		if (!mod) continue;
		for (const imp of mod.imports) {
			if (!imp.isDynamic) continue;
			const resolvedRel = imp.resolvedPath ? relative(ctx.projectRoot, imp.resolvedPath) : null;
			const key = `${rel}|${resolvedRel ?? imp.specifier}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const targetMod = imp.resolvedPath ? ctx.graph.modules.get(imp.resolvedPath) : void 0;
			lazy.push({
				specifier: imp.specifier,
				resolvedFile: resolvedRel,
				importerFile: rel,
				loc: imp.loc,
				sourceBytes: targetMod?.sourceBytes ?? null,
				subtreeBytes: targetMod?.subtreeBytes ?? null,
				bundleBytes: imp.resolvedPath ? lookupBundleBytes(ctx.byteAttribution, imp.resolvedPath, ctx.projectRoot) : null
			});
		}
	}
	return lazy.sort((a, b) => (b.subtreeBytes ?? -1) - (a.subtreeBytes ?? -1));
}
function resolveUsage(importerFile, edge, ctx) {
	const importerMap = ctx.conditionalByImporter.get(importerFile);
	if (!importerMap) return { kind: "always" };
	for (const symbol of edge.namedSymbols) {
		const candidate = importerMap.get(symbol);
		if (!candidate) continue;
		if (edge.isDynamic || edge.isTypeOnly) continue;
		return {
			kind: "conditional",
			componentName: candidate.componentName,
			branch: candidate.branch,
			pathRootCondition: candidate.pathRootCondition,
			routes: candidate.routes.length > 0 ? candidate.routes : void 0,
			importerFile
		};
	}
	return { kind: "always" };
}
function loadKindForImport(edge) {
	if (edge.isTypeOnly) return "type-only";
	if (edge.isDynamic) return "lazy-dynamic";
	return "eager-static";
}
function buildHints(loadKind, usage, resolvedFile, edge, targetMod, ctx) {
	const hints = [];
	const subtreeBytes = edge.subtreeBytes ?? 0;
	if (loadKind === "lazy-dynamic") hints.push("lazy-already");
	if (usage.kind === "conditional" && loadKind === "eager-static") hints.push("branch-exclusive-eager");
	if (subtreeBytes >= ctx.heavySubtreeThreshold) hints.push("heavy-subtree");
	if (resolvedFile && ctx.clientReachable.has(resolvedFile)) hints.push("client-bundle");
	if (edge.packageName && subtreeBytes >= ctx.heavySubtreeThreshold) hints.push("npm-heavy");
	return hints;
}
function signalSummary(mod) {
	if (mod.env !== "client" && mod.env !== "shared") return void 0;
	return {
		hooks: mod.signals.hooks.length,
		eventHandlers: mod.signals.eventHandlers.length,
		browserGlobals: mod.signals.browserGlobals.length,
		useEffectCalls: mod.signals.useEffectCalls.length,
		largestLiteralBytes: mod.signals.largestLiteralBytes
	};
}
function collectFilesInTree(node) {
	const files = new Set([node.file]);
	for (const imp of node.imports) if (imp.child) for (const f of collectFilesInTree(imp.child)) files.add(f);
	else if (imp.resolvedFile) files.add(imp.resolvedFile);
	return files;
}
function getSource(absPath, sourceCache) {
	const cached = sourceCache.get(absPath);
	if (cached !== void 0) return cached;
	const source = readFileSync(absPath, "utf-8");
	sourceCache.set(absPath, source);
	return source;
}
function ensureForestEntry(file, projectRoot, graph, role, entries, compact) {
	const existing = entries.get(file);
	if (existing) return existing;
	const entry = buildForestEntry(file, projectRoot, graph, role, compact);
	entries.set(file, entry);
	return entry;
}
function walkModule$1(absPath, projectRoot, graph, modules, reachable, byteAttribution, collectModules = true) {
	const rel = relative(projectRoot, absPath);
	reachable.add(rel);
	const mod = graph.modules.get(absPath);
	if (!mod) return;
	if (collectModules && !modules.has(rel)) modules.set(rel, toForestModule(absPath, projectRoot, mod, graph, byteAttribution));
	for (const imp of mod.imports) {
		if (imp.isTypeOnly || imp.isDynamic || !imp.resolvedPath) continue;
		if (reachable.has(relative(projectRoot, imp.resolvedPath))) continue;
		walkModule$1(imp.resolvedPath, projectRoot, graph, modules, reachable, byteAttribution, collectModules);
	}
}
function toForestModule(absPath, projectRoot, mod, graph, byteAttribution) {
	return {
		file: relative(projectRoot, absPath),
		runtime: moduleEnvToForestRuntime(mod.env),
		isBoundary: mod.isBoundary,
		directives: [...mod.directives],
		sourceBytes: mod.sourceBytes,
		subtreeBytes: mod.subtreeBytes,
		packageName: packageNameForModule(absPath, projectRoot),
		imports: mod.imports.map((imp) => toImportEdge(imp, projectRoot, graph, byteAttribution))
	};
}
function toImportEdge(imp, projectRoot, graph, byteAttribution) {
	const resolvedAbs = imp.resolvedPath;
	const resolvedFile = resolvedAbs ? relative(projectRoot, resolvedAbs) : null;
	const childMod = resolvedAbs ? graph.modules.get(resolvedAbs) : void 0;
	return {
		specifier: imp.specifier,
		namedSymbols: imp.namedSymbols,
		isDynamic: imp.isDynamic,
		isTypeOnly: imp.isTypeOnly,
		loc: imp.loc,
		resolvedFile,
		packageName: imp.packageName,
		sourceBytes: childMod?.sourceBytes ?? null,
		subtreeBytes: childMod?.subtreeBytes ?? null,
		bundleBytes: resolvedAbs ? lookupBundleBytes(byteAttribution, resolvedAbs, projectRoot) : null
	};
}
function buildForestEntry(file, projectRoot, graph, role, compact) {
	const absPath = resolve(projectRoot, file);
	const mod = graph.modules.get(absPath);
	const source = readFileSync(absPath, "utf-8");
	if (!mod) {
		const entry = {
			file,
			role,
			runtime: "server",
			isBoundary: false,
			directives: [],
			sourceBytes: source.length
		};
		if (!compact) {
			entry.ast = {
				type: "Program",
				sourceType: "module",
				body: []
			};
			entry.defaultExport = null;
		}
		return entry;
	}
	const entry = {
		file,
		role,
		runtime: moduleEnvToForestRuntime(mod.env),
		isBoundary: mod.isBoundary,
		directives: [...mod.directives],
		sourceBytes: mod.sourceBytes
	};
	if (!compact) {
		const program = mod.ast();
		entry.ast = serializeAst(program, source);
		entry.defaultExport = extractDefaultExportJsx(program, source);
	}
	return entry;
}
function lookupBundleBytes(byteAttribution, absPath, projectRoot) {
	if (!byteAttribution) return void 0;
	const rel = relative(projectRoot, absPath);
	return byteAttribution.modules.get(absPath) ?? byteAttribution.modules.get(rel) ?? null;
}
function packageNameForModule(absPath, projectRoot) {
	const rel = relative(projectRoot, absPath);
	if (!rel.startsWith("node_modules/")) return null;
	const parts = rel.split("/");
	if (parts[1]?.startsWith("@") && parts[2]) return `${parts[1]}/${parts[2]}`;
	return parts[1] ?? null;
}
function extractDefaultExportJsx(program, source) {
	const lines = source.split("\n");
	for (const stmt of program.body) if (stmt.type === "ExportDefaultDeclaration") return jsxFromNode(toAst(stmt.declaration), source, lines);
	return null;
}
function jsxFromNode(node, source, lines) {
	if (!node) return null;
	if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
		const body = node.body;
		if (body?.type === "BlockStatement") {
			for (const stmt of body.body ?? []) if (stmt.type === "ReturnStatement") return jsxFromNode(stmt.argument, source, lines);
		}
		return null;
	}
	if (node.type === "ArrowFunctionExpression") {
		const body = node.body;
		if (body.type === "JSXElement" || body.type === "JSXFragment") return jsxFromNode(body, source, lines);
		if (body.type === "BlockStatement") {
			for (const stmt of body.body ?? []) if (stmt.type === "ReturnStatement") return jsxFromNode(stmt.argument, source, lines);
		}
		return null;
	}
	if (node.type === "JSXFragment") return {
		kind: "fragment",
		children: (node.children ?? []).map((child) => jsxFromNode(child, source, lines)).filter((c) => c != null),
		loc: nodeLoc(node, lines)
	};
	if (node.type === "JSXElement") {
		const opening = node.openingElement;
		const nameNode = opening.name;
		const children = (node.children ?? []).map((child) => jsxFromNode(child, source, lines)).filter((c) => c != null);
		return {
			kind: "element",
			name: jsxElementName(nameNode),
			props: jsxProps(opening.attributes, source, lines),
			children,
			loc: nodeLoc(node, lines)
		};
	}
	if (node.type === "JSXText") {
		const value = String(node.value ?? "").trim();
		if (!value) return null;
		return {
			kind: "text",
			name: value,
			loc: nodeLoc(node, lines)
		};
	}
	if (node.type === "JSXExpressionContainer") {
		if (node.expression?.type === "JSXEmptyExpression") return null;
		const loc = nodeLoc(node, lines);
		return {
			kind: "expression",
			name: loc ? sliceSource(source, loc) : void 0,
			loc
		};
	}
	return null;
}
function jsxElementName(node) {
	if (node.type === "JSXIdentifier") return String(node.name);
	if (node.type === "JSXMemberExpression") return `${jsxElementName(node.object)}.${jsxElementName(node.property)}`;
	return "unknown";
}
function jsxProps(attributes, source, lines) {
	const props = {};
	for (const attr of attributes) {
		if (attr.type !== "JSXAttribute") continue;
		const nameNode = attr.name;
		const key = nameNode.type === "JSXIdentifier" ? String(nameNode.name) : nameNode.type === "JSXNamespacedName" ? `${nameNode.namespace}.${nameNode.name}` : "unknown";
		const valueNode = attr.value;
		if (!valueNode) {
			props[key] = {
				kind: "literal",
				value: true
			};
			continue;
		}
		if (valueNode.type === "StringLiteral" || valueNode.type === "Literal") {
			props[key] = {
				kind: "literal",
				value: valueNode.value
			};
			continue;
		}
		if (valueNode.type === "JSXExpressionContainer") {
			const expr = valueNode.expression;
			if (expr?.type === "Identifier") props[key] = {
				kind: "identifier",
				name: String(expr.name)
			};
			else {
				const loc = nodeLoc(valueNode, lines);
				props[key] = {
					kind: "expression",
					text: loc ? sliceSource(source, loc) : ""
				};
			}
		}
	}
	return props;
}
function nodeLoc(node, lines) {
	try {
		return locFromSpan(node, lines);
	} catch {
		return;
	}
}
//#endregion
//#region src/validate.ts
const ENTRY_PATHS = [
	"app",
	"src/app",
	"pages",
	"src/pages",
	"middleware.ts",
	"src/middleware.ts"
];
function validateProject(projectRoot) {
	const errors = [];
	const pkgPath = join(projectRoot, "package.json");
	if (!existsSync(pkgPath)) {
		errors.push("package.json not found in project root");
		return {
			ok: false,
			errors
		};
	}
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch {
		errors.push("package.json is not valid JSON");
		return {
			ok: false,
			errors
		};
	}
	if (!(pkg.dependencies?.next != null || pkg.devDependencies?.next != null)) errors.push("'next' must be listed in dependencies or devDependencies");
	if (!ENTRY_PATHS.some((p) => existsSync(join(projectRoot, p)))) errors.push("No Next.js entry found (expected app/, src/app/, pages/, src/pages/, or middleware.ts)");
	return {
		ok: errors.length === 0,
		errors
	};
}
//#endregion
//#region src/external/knip.ts
const DEPENDENCY_ISSUE_TYPES = ["dependencies", "devDependencies"];
const KNIP_TIMEOUT_MS = 12e4;
/** Minimal knip config — avoid loading Storybook/Vite/etc. plugins. */
const KNIP_BASE_CONFIG = {
	storybook: false,
	eslint: false,
	vitest: false,
	playwright: false,
	cypress: false,
	jest: false,
	mocha: false,
	"github-actions": false
};
async function runKnipMain(options) {
	const { main } = await import("knip");
	return main(options);
}
function withTimeout(promise, ms, label) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolvePromise(value);
		}, (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
function createKnipConfigFile() {
	const dir = mkdtempSync(join(tmpdir(), "wimb-knip-"));
	const path = join(dir, "knip.json");
	writeFileSync(path, JSON.stringify(KNIP_BASE_CONFIG));
	return {
		path,
		cleanup: () => {
			try {
				rmSync(dir, {
					recursive: true,
					force: true
				});
			} catch {}
		}
	};
}
/**
* Run knip and map unused dependencies + unused files/exports that are
* client-reachable (dead code that can ship to the browser).
*/
async function runKnipAnalysis(projectRoot, config, graph) {
	const ignoreUnusedDeps = config.ignores.rules.includes("unused-dependency");
	const ignoreUnusedExports = config.ignores.rules.includes("unused-client-export") || config.ignores.rules.includes("unused-client-file");
	const includedIssueTypes = [];
	if (!ignoreUnusedDeps) includedIssueTypes.push("dependencies");
	if (!ignoreUnusedExports) includedIssueTypes.push("files", "exports", "types");
	if (includedIssueTypes.length === 0) return [];
	const { path: knipConfigPath, cleanup } = createKnipConfigFile();
	try {
		const { issues } = await withTimeout(runKnipMain(await createOptions({
			cwd: projectRoot,
			includedIssueTypes,
			isShowProgress: false,
			args: { config: knipConfigPath }
		})), KNIP_TIMEOUT_MS, "knip analysis");
		const findings = [];
		if (!ignoreUnusedDeps) findings.push(...collectDependencyFindings(issues, config));
		if (!ignoreUnusedExports && graph) findings.push(...collectClientDeadCodeFindings(issues, config, projectRoot, graph));
		return findings;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`wimb: knip analysis skipped (${message})`);
		return [];
	} finally {
		cleanup();
	}
}
function collectDependencyFindings(issues, config) {
	const findings = [];
	for (const issueType of DEPENDENCY_ISSUE_TYPES) for (const issue of flattenIssues(issues[issueType])) {
		if (isPackageIgnored(config, issue.symbol)) continue;
		findings.push(toDependencyFinding(issue, issueType, config));
	}
	return findings;
}
function collectClientDeadCodeFindings(issues, config, projectRoot, graph) {
	const findings = [];
	const clientAbs = new Set([...graph.clientModules].map((p) => resolve(p)));
	const clientRel = new Set([...graph.clientModules].map((p) => relative(projectRoot, p).replace(/\\/g, "/")));
	const isClientPath = (filePath) => {
		const abs = resolve(projectRoot, filePath);
		const rel = relative(projectRoot, abs).replace(/\\/g, "/");
		return clientAbs.has(abs) || clientRel.has(rel) || clientRel.has(filePath.replace(/\\/g, "/"));
	};
	for (const issue of flattenIssues(issues.files ?? {})) {
		if (!isClientPath(issue.filePath)) continue;
		const severity = config.severityOverrides["unused-client-file"] ?? "warning";
		findings.push({
			id: `file:${issue.filePath}:unused-client-file`,
			ruleId: "unused-client-file",
			category: "dependency",
			severity,
			confidence: "medium",
			file: issue.filePath,
			loc: issue.line ? {
				line: issue.line,
				column: issue.col ?? 1
			} : void 0,
			message: `Unused client-reachable file '${issue.filePath}' — dead code that may ship to the browser`,
			evidence: {
				knip: issue,
				kind: "files"
			},
			fixStrategy: {
				name: "remove-dead-file",
				steps: [`Delete unused file '${issue.filePath}' or wire it into a used import`]
			},
			source: "knip"
		});
	}
	for (const issueType of ["exports", "types"]) for (const issue of flattenIssues(issues[issueType] ?? {})) {
		if (!isClientPath(issue.filePath)) continue;
		const severity = config.severityOverrides["unused-client-export"] ?? "info";
		findings.push({
			id: `export:${issue.filePath}:${issue.symbol}:unused-client-export`,
			ruleId: "unused-client-export",
			category: "dependency",
			severity,
			confidence: "medium",
			file: issue.filePath,
			loc: issue.line ? {
				line: issue.line,
				column: issue.col ?? 1
			} : void 0,
			message: `Unused ${issueType === "types" ? "type" : "export"} '${issue.symbol}' in client module`,
			evidence: {
				knip: issue,
				kind: issueType,
				export: issue.symbol
			},
			fixStrategy: {
				name: "remove-dead-export",
				steps: [`Remove unused export '${issue.symbol}' from '${issue.filePath}'`]
			},
			source: "knip"
		});
	}
	return findings;
}
function flattenIssues(records) {
	if (!records) return [];
	if (Array.isArray(records)) return records;
	const result = [];
	for (const workspaceIssues of Object.values(records)) {
		if (!workspaceIssues || typeof workspaceIssues !== "object") continue;
		for (const value of Object.values(workspaceIssues)) if (value && typeof value === "object" && "filePath" in value) result.push(value);
		else if (value && typeof value === "object") {
			for (const issue of Object.values(value)) if (issue && typeof issue === "object" && "filePath" in issue) result.push(issue);
		}
	}
	return result;
}
function isPackageIgnored(config, packageName) {
	return config.ignores.files.some((pattern) => packageName.includes(pattern));
}
function toDependencyFinding(issue, issueType, config) {
	const field = issueType === "devDependencies" ? "devDependencies" : "dependencies";
	const severity = config.severityOverrides["unused-dependency"] ?? "info";
	return {
		id: `pkg:${issue.workspace}:${issue.symbol}:unused-dependency`,
		ruleId: "unused-dependency",
		category: "dependency",
		severity,
		confidence: "high",
		file: issue.filePath,
		loc: issue.line ? {
			line: issue.line,
			column: issue.col ?? 1
		} : void 0,
		message: `Unused ${field === "devDependencies" ? "devDependency" : "dependency"} '${issue.symbol}'`,
		evidence: {
			package: issue.symbol,
			field,
			workspace: issue.workspace,
			knip: issue
		},
		fixStrategy: {
			name: "remove-dep",
			steps: [`Remove '${issue.symbol}' from package.json ${field}`]
		},
		source: "knip"
	};
}
//#endregion
//#region src/analysis/package-size.ts
/**
* Enrich `pkg.installSizes` for packages reachable from the client graph.
* Prefer measured bundle attribution when available; otherwise sum package
* dist files (excluding nested node_modules) and cache under `.wimb/cache.json`.
*/
async function measureClientPackageSizes(projectRoot, graph, pkg, byteAttribution) {
	const clientPackages = collectClientPackages(graph);
	if (clientPackages.size === 0) return;
	const cache = loadCache(projectRoot);
	let dirty = false;
	for (const name of clientPackages) {
		if (byteAttribution?.modules.has(name)) {
			const bytes = byteAttribution.modules.get(name);
			pkg.installSizes.set(name, bytes);
			continue;
		}
		const version = resolveInstalledVersion(projectRoot, name) ?? pkg.dependencies[name] ?? "unknown";
		const cacheKey = `${name}@${version}`;
		const cached = cache.packages[cacheKey];
		if (cached) {
			pkg.installSizes.set(name, cached.bytes);
			continue;
		}
		const bytes = measurePackageDir(projectRoot, name);
		pkg.installSizes.set(name, bytes);
		cache.packages[cacheKey] = {
			version,
			bytes,
			measuredAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		dirty = true;
	}
	if (dirty) saveCache(projectRoot, cache);
}
function collectClientPackages(graph) {
	const packages = /* @__PURE__ */ new Set();
	for (const path of graph.clientModules) {
		const mod = graph.modules.get(path);
		if (!mod) continue;
		for (const imp of mod.imports) if (imp.packageName) packages.add(imp.packageName);
	}
	return packages;
}
function measurePackageDir(projectRoot, packageName) {
	const pkgDir = join(projectRoot, "node_modules", packageName);
	if (!existsSync(pkgDir)) return 0;
	for (const sub of [
		"dist",
		"build",
		"lib",
		"esm",
		"es"
	]) {
		const candidate = join(pkgDir, sub);
		if (existsSync(candidate)) return du(candidate);
	}
	return du(pkgDir);
}
function du(dir) {
	let total = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				total += du(path);
			} else if (/\.(js|mjs|cjs|jsx|ts|tsx|json|wasm|css)$/i.test(entry.name)) total += statSync(path).size;
		}
	} catch {
		return total;
	}
	return total;
}
function resolveInstalledVersion(projectRoot, packageName) {
	try {
		const pkgJsonPath = createRequire(join(projectRoot, "package.json")).resolve(`${packageName}/package.json`);
		return JSON.parse(readFileSync(pkgJsonPath, "utf-8")).version ?? null;
	} catch {
		const pkgJson = join(projectRoot, "node_modules", packageName, "package.json");
		if (!existsSync(pkgJson)) return null;
		try {
			return JSON.parse(readFileSync(pkgJson, "utf-8")).version ?? null;
		} catch {
			return null;
		}
	}
}
function cachePath(projectRoot) {
	return join(resolveOutputDir(projectRoot), "cache.json");
}
function loadCache(projectRoot) {
	const path = cachePath(projectRoot);
	if (!existsSync(path)) return { packages: {} };
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { packages: {} };
	}
}
function saveCache(projectRoot, cache) {
	mkdirSync(resolveOutputDir(projectRoot), { recursive: true });
	writeFileSync(cachePath(projectRoot), JSON.stringify(cache, null, 2));
}
//#endregion
//#region src/scan.ts
async function scan(opts) {
	const projectRoot = opts.projectRoot;
	if (!opts.skipValidation) {
		const validation = validateProject(projectRoot);
		if (!validation.ok) {
			for (const err of validation.errors) console.error(`wimb: ${err}`);
			return 2;
		}
	}
	const config = await loadConfig(projectRoot);
	const graph = await buildGraph(projectRoot);
	const pkg = loadPackageInfo(projectRoot);
	const data = loadDataTables();
	const nextConfig = await parseNextConfig(projectRoot);
	const resolvedDist = opts.distDir ?? resolveDistDir(projectRoot, nextConfig?.distDir);
	const existingAnalyze = hasAnalyzeArtifacts(resolvedDist);
	let byteAttribution = null;
	if (opts.build || opts.distDir || existingAnalyze || opts.analyzeExportPath) byteAttribution = await runBuildAnalysis({
		projectRoot,
		distDir: resolvedDist,
		skipBuild: !!opts.analyzeExportPath || !!opts.distDir || !opts.build && existingAnalyze,
		snapshot: opts.snapshot,
		analyzeExportPath: opts.analyzeExportPath
	});
	await measureClientPackageSizes(projectRoot, graph, pkg, byteAttribution);
	const findings = [];
	const shouldIgnore = (ruleId) => config.ignores.rules.includes(ruleId) || config.ignores.rules.some((r) => r.endsWith(":") && ruleId.startsWith(r));
	const ctx = {
		projectRoot,
		graph,
		config,
		pkg,
		data,
		nextConfig,
		byteAttribution,
		report: (f) => {
			if (shouldIgnore(f.ruleId)) return;
			findings.push(labelByteSource(f, byteAttribution));
		}
	};
	for (const rule of getAllRules()) rule.run(ctx);
	if (!shouldIgnore("unused-dependency") || !shouldIgnore("unused-client-export")) {
		console.log("wimb: checking unused code with knip...");
		for (const finding of await runKnipAnalysis(projectRoot, config, graph)) {
			if (shouldIgnore(finding.ruleId)) continue;
			findings.push(finding);
		}
	}
	const report = buildReport(projectRoot, opts.build || byteAttribution?.measured ? "build" : "source", findings, { byteSource: byteAttribution?.measured ? "measured" : "estimated" });
	writeReports(projectRoot, report, new Set(opts.formats ?? ["json", "md"]));
	console.log("wimb: writing forest.json...");
	const forest = writeForestReport(projectRoot, graph, byteAttribution, {
		compact: opts.forestCompact,
		heavySubtreeThreshold: config.thresholds.dynamicImportMinSubtree,
		verbose: true
	});
	printFindingsToTerminal(report);
	console.log(`wimb: ${report.summary.total} findings (${report.summary.bySeverity.error} errors, ${report.summary.bySeverity.warning} warnings), ${forest.pages.length} pages → ${resolveOutputDir(projectRoot)}`);
	if (byteAttribution?.measured) console.log("wimb: measured graph available — run `wimb wins` for ranked, agent-ready fixes");
	return exitCodeForReport(report, opts.exitThreshold ?? "error");
}
function labelByteSource(finding, byteAttribution) {
	if (finding.estimatedBytes == null) return finding;
	if (finding.byteSource) return finding;
	return {
		...finding,
		byteSource: byteAttribution?.measured ? "measured" : "estimated"
	};
}
//#endregion
//#region ../graph-v1/dist/parse-s08Ga0Rr.js
/** Strip Turbopack virtual prefixes like `[project]/` / `[client-fs]/`. */
function normalizeModulePath(raw) {
	if (!raw) return "";
	return raw.replace(/^\[project\]\//, "").replace(/^\[client-fs\]\//, "").replace(/^\[project\]/, "").replace(/^\[client-fs\]/, "").replace(/\\/g, "/");
}
function packageNameFromPath(path) {
	const idx = path.lastIndexOf("node_modules/");
	if (idx === -1) return null;
	const rest = path.slice(idx + 13);
	if (rest.startsWith("@")) {
		const parts = rest.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	}
	return rest.split("/")[0] ?? null;
}
function isClientJavaScriptOutput(filename) {
	return filename.startsWith("[client-fs]/") && filename.endsWith(".js");
}
/** Server / RSC JS outputs (any `.js` that is not client-fs). */
function isServerJavaScriptOutput(filename) {
	return filename.endsWith(".js") && !filename.startsWith("[client-fs]/");
}
/** First-party app/source files (not deps, Next internals, or synthetic nodes). */
function isAppSourcePath(path) {
	if (!path) return false;
	if (path.startsWith("source:")) return false;
	if (path.startsWith("[")) return false;
	if (path.endsWith("/")) return false;
	if (path.includes("node_modules/")) return false;
	if (path.startsWith("next/") || path.startsWith("_next/")) return false;
	if (path.startsWith("turbopack/") || path.startsWith("[turbopack]")) return false;
	const base = path.split("/").pop() ?? path;
	return /\.(tsx?|jsx?|mjs|cjs|css|scss)$/i.test(base);
}
/** Short display label: package name for node_modules, otherwise the path. */
function displayLabel(path) {
	return packageNameFromPath(path) ?? path;
}
function numberOrZero(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function emptyParsed() {
	return {
		meta: null,
		modules: /* @__PURE__ */ new Map(),
		routes: /* @__PURE__ */ new Map(),
		clientPartsByRoute: /* @__PURE__ */ new Map(),
		serverPartsByRoute: /* @__PURE__ */ new Map(),
		pathRouteUsage: /* @__PURE__ */ new Map(),
		serverPathRouteUsage: /* @__PURE__ */ new Map(),
		outputs: [],
		groups: []
	};
}
function addPartBytes(byRoute, usage, route, path, bytes) {
	let routeMap = byRoute.get(route);
	if (!routeMap) {
		routeMap = /* @__PURE__ */ new Map();
		byRoute.set(route, routeMap);
	}
	routeMap.set(path, (routeMap.get(path) ?? 0) + bytes);
	let set = usage.get(path);
	if (!set) {
		set = /* @__PURE__ */ new Set();
		usage.set(path, set);
	}
	set.add(route);
}
function ingestPart(graph, part) {
	if (!part.route) return;
	const filename = part.filename ?? "";
	const path = normalizeModulePath(part.source_path ?? "");
	if (!path) return;
	const bytes = numberOrZero(part.compressed_size) > 0 ? numberOrZero(part.compressed_size) : numberOrZero(part.size);
	if (isClientJavaScriptOutput(filename)) addPartBytes(graph.clientPartsByRoute, graph.pathRouteUsage, part.route, path, bytes);
	else if (isServerJavaScriptOutput(filename)) addPartBytes(graph.serverPartsByRoute, graph.serverPathRouteUsage, part.route, path, bytes);
}
function ensureRoutesFromParts(graph) {
	for (const route of [...graph.clientPartsByRoute.keys(), ...graph.serverPartsByRoute.keys()]) if (!graph.routes.has(route)) graph.routes.set(route, {
		type: "route",
		route,
		entries: null,
		coverage: {
			entries: "unknown",
			groups: "unknown"
		}
	});
}
function ingestRecord(graph, record) {
	switch (record.type) {
		case "meta":
			graph.meta = record;
			break;
		case "module": {
			const mod = record;
			if (mod.ident) graph.modules.set(mod.ident, mod);
			break;
		}
		case "route": {
			const route = record;
			if (route.route) graph.routes.set(route.route, route);
			break;
		}
		case "part":
			ingestPart(graph, record);
			break;
		case "output":
			graph.outputs.push(record);
			break;
		case "group":
			graph.groups.push(record);
			break;
		default: break;
	}
}
/** Parse a full graph-v1 JSONL string into indexes. */
function parseGraphV1Jsonl(jsonl) {
	const graph = emptyParsed();
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let record;
		try {
			record = JSON.parse(trimmed);
		} catch {
			continue;
		}
		ingestRecord(graph, record);
	}
	ensureRoutesFromParts(graph);
	return graph;
}
//#endregion
//#region ../graph-v1/dist/index.js
const DEFAULT_MAX_DEPTH = 40;
function partsMap(graph, side) {
	return side === "server" ? graph.serverPartsByRoute : graph.clientPartsByRoute;
}
function usageMap(graph, side) {
	return side === "server" ? graph.serverPathRouteUsage : graph.pathRouteUsage;
}
function routeBytes(graph, route, side) {
	const parts = partsMap(graph, side).get(route);
	if (!parts) return 0;
	let total = 0;
	for (const bytes of parts.values()) total += bytes;
	return total;
}
function selfBytesForPath(graph, route, path, side) {
	return partsMap(graph, side).get(route)?.get(path) ?? 0;
}
function routeCountForPath(graph, path, side) {
	return usageMap(graph, side).get(path)?.size ?? 0;
}
function collectSeeds$1(graph, routePath, side) {
	const route = graph.routes.get(routePath);
	const seeds = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (ident, edgeKind) => {
		if (!ident || seen.has(ident)) return;
		seen.add(ident);
		seeds.push({
			ident,
			edgeKind
		});
	};
	if (route?.entries) {
		const clientRefs = [];
		const bootstraps = [];
		const serverEntries = [];
		const routeEntries = [];
		for (const entry of route.entries) {
			if (entry.entry_kind === "client_bootstrap") bootstraps.push({
				ident: entry.module_ident,
				edgeKind: "entry"
			});
			else if (entry.entry_kind === "server") serverEntries.push({
				ident: entry.module_ident,
				edgeKind: "entry"
			});
			else if (entry.role === "route") routeEntries.push({
				ident: entry.module_ident,
				edgeKind: "entry"
			});
			for (const ref of entry.client_references ?? []) if (ref.reference_kind === "ecmascript") clientRefs.push({
				ident: ref.module_ident,
				edgeKind: "client_reference"
			});
		}
		const preferred = side === "client" ? clientRefs.length > 0 || bootstraps.length > 0 ? [...bootstraps, ...clientRefs] : routeEntries : serverEntries.length > 0 ? serverEntries : routeEntries;
		for (const seed of preferred) push(seed.ident, seed.edgeKind);
	}
	if (seeds.length === 0) {
		const parts = partsMap(graph, side).get(routePath);
		if (parts) {
			const pathToIdents = /* @__PURE__ */ new Map();
			for (const mod of graph.modules.values()) {
				const p = normalizeModulePath(mod.path);
				if (!p) continue;
				let list = pathToIdents.get(p);
				if (!list) {
					list = [];
					pathToIdents.set(p, list);
				}
				list.push(mod.ident);
			}
			for (const path of parts.keys()) for (const ident of pathToIdents.get(path) ?? []) push(ident, "entry");
		}
	}
	return seeds;
}
function leafNode(ident, path, label, selfBytes, routeCount, edgeKind, flags = {}) {
	return {
		kind: "module",
		id: ident,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes,
		routeCount,
		edgeKind,
		cycle: flags.cycle,
		shared: flags.shared,
		children: []
	};
}
function walkModule(graph, routePath, ident, edgeKind, ancestors, depth, opts, expanded) {
	const side = opts.side;
	const mod = graph.modules.get(ident);
	const path = normalizeModulePath(mod?.path ?? ident);
	const label = displayLabel(path);
	const selfBytes = selfBytesForPath(graph, routePath, path, side);
	const routeCount = routeCountForPath(graph, path, side);
	if (ancestors.has(ident)) return leafNode(ident, path, label, selfBytes, routeCount, edgeKind, { cycle: true });
	if (expanded.has(ident)) return leafNode(ident, path, label, selfBytes, routeCount, edgeKind, { shared: true });
	if (depth >= opts.maxDepth || !mod) return leafNode(ident, path, label, selfBytes, routeCount, edgeKind);
	expanded.add(ident);
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(ident);
	const children = [];
	const childIdents = [];
	for (const dep of mod.dependencies.sync) childIdents.push({
		ident: dep,
		edgeKind: "sync"
	});
	if (opts.includeAsync) for (const dep of mod.dependencies.async) childIdents.push({
		ident: dep,
		edgeKind: "async"
	});
	if (opts.includeTraced) for (const dep of mod.dependencies.traced) childIdents.push({
		ident: dep,
		edgeKind: "sync"
	});
	const seenChild = /* @__PURE__ */ new Set();
	for (const child of childIdents) {
		if (seenChild.has(child.ident)) continue;
		seenChild.add(child.ident);
		children.push(walkModule(graph, routePath, child.ident, child.edgeKind, nextAncestors, depth + 1, opts, expanded));
	}
	children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));
	return {
		kind: "module",
		id: ident,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes + children.reduce((sum, c) => sum + (c.shared || c.cycle ? 0 : c.totalBytes), 0),
		routeCount,
		edgeKind,
		children
	};
}
/** Build a single route-rooted tree. */
function buildRouteTree(graph, routePath, options = {}) {
	const opts = {
		includeAsync: options.includeAsync ?? false,
		includeTraced: options.includeTraced ?? false,
		maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
		side: options.side ?? "client"
	};
	const seeds = collectSeeds$1(graph, routePath, opts.side);
	const children = [];
	const seenRoot = /* @__PURE__ */ new Set();
	const expanded = /* @__PURE__ */ new Set();
	for (const seed of seeds) {
		if (seenRoot.has(seed.ident)) continue;
		seenRoot.add(seed.ident);
		children.push(walkModule(graph, routePath, seed.ident, seed.edgeKind, /* @__PURE__ */ new Set(), 0, opts, expanded));
	}
	if (children.length === 0) {
		const parts = partsMap(graph, opts.side).get(routePath);
		if (parts) for (const [path, bytes] of parts) children.push({
			kind: "module",
			id: path,
			label: displayLabel(path),
			path,
			selfBytes: bytes,
			totalBytes: bytes,
			routeCount: routeCountForPath(graph, path, opts.side),
			edgeKind: "entry",
			children: []
		});
	}
	children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));
	return {
		kind: "route",
		id: routePath,
		label: routePath,
		selfBytes: 0,
		totalBytes: routeBytes(graph, routePath, opts.side),
		routeCount: 1,
		children
	};
}
function countModules$1(node) {
	if (node.kind === "module") return 1 + node.children.reduce((n, c) => n + countModules$1(c), 0);
	return node.children.reduce((n, c) => n + countModules$1(c), 0);
}
function buildSide(graph, options, side) {
	const trees = {};
	const routes = [];
	const routePaths = [...graph.routes.keys()].sort();
	for (const routePath of routePaths) {
		const tree = buildRouteTree(graph, routePath, {
			...options,
			side
		});
		trees[routePath] = tree;
		routes.push({
			route: routePath,
			totalBytes: tree.totalBytes,
			moduleCount: countModules$1(tree)
		});
	}
	routes.sort((a, b) => b.totalBytes - a.totalBytes || a.route.localeCompare(b.route));
	return {
		routes,
		trees
	};
}
/** Build client + server forests for the visualizer side filter. */
function buildDualRouteForest(graph, options = {}) {
	const client = buildSide(graph, options, "client");
	const server = buildSide(graph, options, "server");
	return {
		schemaVersion: 2,
		meta: {
			snapshotName: graph.meta?.snapshot_name ?? null,
			routeCount: graph.meta?.route_count ?? Math.max(client.routes.length, server.routes.length),
			selectedRoutes: graph.meta?.selected_routes ?? Math.max(client.routes.length, server.routes.length)
		},
		routes: client.routes,
		trees: client.trees,
		sides: {
			client,
			server
		}
	};
}
//#endregion
//#region ../graph-v1/dist/parse-file.js
/** Read `.jsonl` or `.jsonl.gz` from disk (Node only). */
function parseGraphV1File(filePath) {
	const buf = readFileSync(filePath);
	return parseGraphV1Jsonl(filePath.endsWith(".gz") ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8"));
}
//#endregion
//#region src/wins/vite.ts
function isViteProject(projectRoot) {
	const pkgPath = join(projectRoot, "package.json");
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const deps = {
			...pkg.dependencies,
			...pkg.devDependencies
		};
		return !!deps.vite && !deps.next;
	} catch {
		return false;
	}
}
function modulePath(projectRoot, id) {
	const clean = id.split("?")[0];
	if (!isAbsolute(clean)) return normalizeModulePath(clean);
	return normalizeModulePath(relative(realpathSync(projectRoot), clean));
}
/** Runs `vite build` in-process (no files written) and builds a graph from Rollup's chunks and module edges. */
async function buildGraphFromVite(projectRoot) {
	const req = createRequire(join(projectRoot, "package.json"));
	let vite;
	try {
		vite = await import(req.resolve("vite"));
	} catch {
		throw new Error("Could not resolve 'vite' from the project. Install it or run from the project root.");
	}
	const edges = /* @__PURE__ */ new Map();
	const chunks = [];
	await vite.build({
		root: realpathSync(projectRoot),
		logLevel: "warn",
		plugins: [{
			name: "wimb-collect",
			generateBundle(_o, bundle) {
				for (const item of Object.values(bundle)) {
					if (item.type !== "chunk") continue;
					chunks.push(item);
					for (const id of Object.keys(item.modules)) {
						const info = this.getModuleInfo(id);
						if (!info || id.startsWith("\0")) continue;
						edges.set(id, {
							sync: new Set(info.importedIds),
							async: new Set(info.dynamicallyImportedIds)
						});
					}
				}
			}
		}],
		build: {
			write: false,
			reportCompressedSize: false
		}
	});
	const modules = /* @__PURE__ */ new Map();
	const idOf = (id) => id.startsWith("\0") ? null : modulePath(projectRoot, id);
	const ensure = (ident) => {
		let m = modules.get(ident);
		if (!m) {
			m = {
				type: "module",
				ident,
				path: ident,
				dependencies: {
					sync: [],
					async: [],
					traced: []
				}
			};
			modules.set(ident, m);
		}
		return m;
	};
	for (const [id, e] of edges) {
		const from = idOf(id);
		if (!from) continue;
		const m = ensure(from);
		for (const [set, out] of [[e.sync, m.dependencies.sync], [e.async, m.dependencies.async]]) for (const d of set) {
			const to = idOf(d);
			if (to && to !== from) out.push(ensure(to).ident);
		}
	}
	const byFile = new Map(chunks.map((c) => [c.fileName, c]));
	const routes = /* @__PURE__ */ new Map();
	const clientPartsByRoute = /* @__PURE__ */ new Map();
	const pathRouteUsage = /* @__PURE__ */ new Map();
	for (const entry of chunks.filter((c) => c.isEntry)) {
		const route = entry.name === "index" ? "/" : `/${entry.name}`;
		const parts = /* @__PURE__ */ new Map();
		const seen = /* @__PURE__ */ new Set();
		const visit = (c) => {
			if (!c || seen.has(c.fileName)) return;
			seen.add(c.fileName);
			const total = Object.values(c.modules).reduce((s, m) => s + m.renderedLength, 0) || 1;
			const ratio = gzipSync(c.code).length / total;
			for (const [id, m] of Object.entries(c.modules)) {
				const p = idOf(id);
				if (!p) continue;
				parts.set(p, (parts.get(p) ?? 0) + m.renderedLength * ratio);
			}
			for (const i of c.imports) visit(byFile.get(i));
		};
		visit(entry);
		for (const p of parts.keys()) {
			ensure(p);
			let s = pathRouteUsage.get(p);
			if (!s) pathRouteUsage.set(p, s = /* @__PURE__ */ new Set());
			s.add(route);
		}
		const facade = entry.facadeModuleId && idOf(entry.facadeModuleId) || "";
		if (facade) ensure(facade);
		routes.set(route, {
			type: "route",
			route,
			entries: [{
				route_entry_id: `${route}#client`,
				module_ident: facade,
				module_path: facade,
				role: "route",
				entry_kind: "client_bootstrap",
				client_references: facade ? [{
					module_ident: facade,
					module_path: facade,
					reference_kind: "ecmascript"
				}] : []
			}],
			coverage: {
				entries: "exact",
				groups: "unknown"
			}
		});
		clientPartsByRoute.set(route, new Map([...parts].map(([k, v]) => [k, Math.round(v)])));
	}
	return {
		meta: null,
		modules,
		routes,
		clientPartsByRoute,
		serverPartsByRoute: /* @__PURE__ */ new Map(),
		pathRouteUsage,
		serverPathRouteUsage: /* @__PURE__ */ new Map(),
		outputs: [],
		groups: []
	};
}
//#endregion
//#region src/viz/binary-importers.ts
function loadModuleIndex(dataDir) {
	const modulesPath = join(dataDir, "modules.data");
	if (!existsSync(modulesPath)) return null;
	try {
		const { header, binary } = parseDataFile(readFileSync(modulesPath));
		const modules = header.modules ?? [];
		const pathToIndices = /* @__PURE__ */ new Map();
		for (let i = 0; i < modules.length; i++) {
			const path = normalizeModulePath(modules[i]?.path ?? "");
			if (!path) continue;
			let list = pathToIndices.get(path);
			if (!list) {
				list = [];
				pathToIndices.set(path, list);
			}
			list.push(i);
		}
		return {
			modules,
			pathToIndices,
			depsRef: header.module_dependencies,
			asyncDepsRef: header.async_module_dependencies,
			binary
		};
	} catch {
		return null;
	}
}
function classifyOutput$1(filename) {
	if (!filename.endsWith(".js")) return "other";
	if (filename.startsWith("[client-fs]/")) return "client";
	return "server";
}
function routePathBytes(filePath, side) {
	const out = /* @__PURE__ */ new Map();
	try {
		const { header, binary } = parseDataFile(readFileSync(filePath));
		const sources = header.sources ?? [];
		const chunkParts = header.chunk_parts ?? [];
		const outputFiles = header.output_files ?? [];
		const fullPaths = buildFullPaths(sources);
		let anyClient = false;
		let anyServer = false;
		const clientBytes = new Array(sources.length).fill(0);
		const serverBytes = new Array(sources.length).fill(0);
		for (let i = 0; i < sources.length; i++) {
			const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
			let cComp = 0;
			let cSize = 0;
			let sComp = 0;
			let sSize = 0;
			for (const cpIdx of partIndices) {
				const cp = chunkParts[cpIdx];
				if (!cp) continue;
				const kind = classifyOutput$1(outputFiles[cp.output_file_index]?.filename ?? "");
				if (kind === "client") {
					anyClient = true;
					cComp += cp.compressed_size;
					cSize += cp.size;
				} else if (kind === "server") {
					anyServer = true;
					sComp += cp.compressed_size;
					sSize += cp.size;
				}
			}
			clientBytes[i] = cComp > 0 ? cComp : cSize;
			serverBytes[i] = sComp > 0 ? sComp : sSize;
		}
		if (!anyClient && !anyServer) for (let i = 0; i < sources.length; i++) {
			const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
			let size = 0;
			let compressed = 0;
			for (const cpIdx of partIndices) {
				const cp = chunkParts[cpIdx];
				if (!cp) continue;
				size += cp.size;
				compressed += cp.compressed_size;
			}
			clientBytes[i] = compressed > 0 ? compressed : size;
		}
		for (let i = 0; i < sources.length; i++) {
			const path = normalizeModulePath(fullPaths[i] ?? "");
			if (!path) continue;
			const bytes = side === "client" ? clientBytes[i] : serverBytes[i];
			if (bytes <= 0) continue;
			out.set(path, (out.get(path) ?? 0) + bytes);
		}
	} catch {}
	return out;
}
function depLabel(path) {
	return packageNameFromPath(path) ?? displayLabel(path);
}
function depKind(path) {
	if (isAppSourcePath(path)) return "app";
	const pkg = packageNameFromPath(path);
	if (pkg === "next" || path.includes("/next/dist/") || path.startsWith("next/")) return "next";
	if (pkg) return "package";
	return "other";
}
function closurePull(index, startPath, pathBytes, pathRouteUsage) {
	const starts = index.pathToIndices.get(startPath) ?? [];
	if (starts.length === 0) {
		const self = pathBytes.get(startPath) ?? 0;
		return {
			pullBytes: self,
			topDeps: [],
			badges: {
				sync: 0,
				async: 0,
				modules: self > 0 ? 1 : 0,
				packages: 0
			}
		};
	}
	let directSync = 0;
	let directAsync = 0;
	for (const i of starts) {
		directSync += readEdgesAtIndex(index.binary, index.depsRef, i).length;
		directAsync += readEdgesAtIndex(index.binary, index.asyncDepsRef, i).length;
	}
	const syncReach = /* @__PURE__ */ new Set();
	const asyncReach = /* @__PURE__ */ new Set();
	const syncQueue = [...starts];
	while (syncQueue.length > 0) {
		const i = syncQueue.pop();
		if (syncReach.has(i)) continue;
		syncReach.add(i);
		for (const d of readEdgesAtIndex(index.binary, index.depsRef, i)) if (!syncReach.has(d)) syncQueue.push(d);
	}
	const asyncQueue = [];
	for (const i of starts) for (const d of readEdgesAtIndex(index.binary, index.asyncDepsRef, i)) asyncQueue.push(d);
	for (const i of syncReach) {
		if (starts.includes(i)) continue;
		for (const d of readEdgesAtIndex(index.binary, index.asyncDepsRef, i)) asyncQueue.push(d);
	}
	while (asyncQueue.length > 0) {
		const i = asyncQueue.pop();
		if (asyncReach.has(i)) continue;
		asyncReach.add(i);
		for (const d of readEdgesAtIndex(index.binary, index.depsRef, i)) if (!asyncReach.has(d)) asyncQueue.push(d);
		for (const d of readEdgesAtIndex(index.binary, index.asyncDepsRef, i)) if (!asyncReach.has(d)) asyncQueue.push(d);
	}
	const all = new Set([...syncReach, ...asyncReach]);
	const pathReach = /* @__PURE__ */ new Map();
	const packages = /* @__PURE__ */ new Set();
	for (const i of all) {
		const p = normalizeModulePath(index.modules[i]?.path ?? "");
		if (!p) continue;
		const viaSync = syncReach.has(i);
		const viaAsync = asyncReach.has(i);
		const reach = viaSync && viaAsync ? "both" : viaAsync ? "async" : "sync";
		const prev = pathReach.get(p);
		if (!prev) pathReach.set(p, reach);
		else if (prev !== reach) pathReach.set(p, "both");
		const pkg = packageNameFromPath(p);
		if (pkg) packages.add(pkg);
	}
	let pullBytes = 0;
	let attributedModules = 0;
	const deps = [];
	for (const [p, reach] of pathReach) {
		const bytes = pathBytes.get(p) ?? 0;
		if (bytes <= 0) continue;
		pullBytes += bytes;
		attributedModules += 1;
		if (p === startPath) continue;
		deps.push({
			path: p,
			label: depLabel(p),
			bytes,
			reach,
			kind: depKind(p),
			routeCount: pathRouteUsage.get(p)?.size ?? 0
		});
	}
	deps.sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
	return {
		pullBytes,
		topDeps: deps.slice(0, 10),
		badges: {
			sync: directSync,
			async: directAsync,
			modules: attributedModules,
			packages: packages.size
		}
	};
}
/**
* Rank app-owned files by what their import graph pulls into each route.
* Uses modules.data edges — not the path-segment source_children tree.
*/
function rankBinaryImportersByRoute(dataDir, side) {
	const index = loadModuleIndex(dataDir);
	if (!index) return {};
	const routeFiles = discoverRouteAnalyzeFiles(dataDir);
	const pathRouteUsage = /* @__PURE__ */ new Map();
	const perRouteBytes = /* @__PURE__ */ new Map();
	for (const { route, filePath } of routeFiles) {
		const pathBytes = routePathBytes(filePath, side);
		perRouteBytes.set(route, pathBytes);
		for (const [path, bytes] of pathBytes) {
			if (bytes <= 0) continue;
			let usage = pathRouteUsage.get(path);
			if (!usage) {
				usage = /* @__PURE__ */ new Set();
				pathRouteUsage.set(path, usage);
			}
			usage.add(route);
		}
	}
	const out = {};
	const pullRouteUsage = /* @__PURE__ */ new Map();
	for (const [route, pathBytes] of perRouteBytes) {
		const candidates = new Set([...pathBytes.keys(), ...index.pathToIndices.keys()]);
		const rows = [];
		for (const path of candidates) {
			if (!isAppSourcePath(path)) continue;
			const { pullBytes, topDeps, badges } = closurePull(index, path, pathBytes, pathRouteUsage);
			if (pullBytes <= 0) continue;
			const selfBytes = pathBytes.get(path) ?? 0;
			let usage = pullRouteUsage.get(path);
			if (!usage) {
				usage = /* @__PURE__ */ new Set();
				pullRouteUsage.set(path, usage);
			}
			usage.add(route);
			rows.push({
				path,
				label: displayLabel(path),
				selfBytes,
				pullBytes,
				routeCount: 0,
				appFile: true,
				badges: {
					...badges,
					routes: 0
				},
				topDeps
			});
		}
		rows.sort((a, b) => b.pullBytes - a.pullBytes || b.selfBytes - a.selfBytes || a.label.localeCompare(b.label));
		out[route] = rows;
	}
	for (const rows of Object.values(out)) for (const row of rows) {
		const routes = pullRouteUsage.get(row.path)?.size ?? pathRouteUsage.get(row.path)?.size ?? 0;
		row.routeCount = routes;
		if (row.badges) row.badges.routes = routes;
	}
	return out;
}
//#endregion
//#region src/viz/binary-forest.ts
function classifyOutput(filename) {
	if (!filename.endsWith(".js")) return "other";
	if (filename.startsWith("[client-fs]/")) return "client";
	return "server";
}
function loadRouteSources(filePath) {
	try {
		const { header, binary } = parseDataFile(readFileSync(filePath));
		const sources = header.sources ?? [];
		const fullPaths = buildFullPaths(sources);
		const chunkParts = header.chunk_parts ?? [];
		const outputFiles = header.output_files ?? [];
		return {
			attrs: sources.map((_, i) => {
				const partIndices = readEdgesAtIndex(binary, header.source_chunk_parts, i);
				let clientCompressed = 0;
				let clientSize = 0;
				let serverCompressed = 0;
				let serverSize = 0;
				let sawClient = false;
				let sawServer = false;
				for (const cpIdx of partIndices) {
					const cp = chunkParts[cpIdx];
					if (!cp) continue;
					const of = outputFiles[cp.output_file_index];
					const kind = classifyOutput(of?.filename ?? "");
					if (kind === "client") {
						sawClient = true;
						clientCompressed += cp.compressed_size;
						clientSize += cp.size;
					} else if (kind === "server") {
						sawServer = true;
						serverCompressed += cp.compressed_size;
						serverSize += cp.size;
					}
				}
				if (!sawClient && !sawServer) for (const cpIdx of partIndices) {
					const cp = chunkParts[cpIdx];
					if (!cp) continue;
					clientCompressed += cp.compressed_size;
					clientSize += cp.size;
				}
				return {
					path: normalizeModulePath(fullPaths[i] ?? sources[i]?.path ?? ""),
					clientBytes: sawClient || !sawClient && !sawServer ? clientCompressed > 0 ? clientCompressed : clientSize : 0,
					serverBytes: sawServer ? serverCompressed > 0 ? serverCompressed : serverSize : 0,
					children: readEdgesAtIndex(binary, header.source_children, i)
				};
			}),
			roots: header.source_roots && header.source_roots.length > 0 ? header.source_roots : [0]
		};
	} catch {
		return null;
	}
}
function walkSource(attrs, index, side, pathRouteUsage, ancestors, expanded) {
	const src = attrs[index];
	const path = src?.path || `source:${index}`;
	const label = displayLabel(path) || path;
	const selfBytes = side === "client" ? src?.clientBytes ?? 0 : src?.serverBytes ?? 0;
	const routeCount = pathRouteUsage.get(path)?.size ?? 0;
	if (ancestors.has(index)) return {
		kind: "module",
		id: path,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes,
		routeCount,
		edgeKind: "sync",
		cycle: true,
		children: []
	};
	if (expanded.has(index)) return {
		kind: "module",
		id: path,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes,
		routeCount,
		edgeKind: "sync",
		shared: true,
		children: []
	};
	expanded.add(index);
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(index);
	const children = [];
	const seenChild = /* @__PURE__ */ new Set();
	for (const childIdx of src?.children ?? []) {
		if (seenChild.has(childIdx)) continue;
		seenChild.add(childIdx);
		if (childIdx < 0 || childIdx >= attrs.length) continue;
		children.push(walkSource(attrs, childIdx, side, pathRouteUsage, nextAncestors, expanded));
	}
	children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));
	return {
		kind: "module",
		id: path,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes + children.reduce((sum, c) => sum + (c.shared || c.cycle ? 0 : c.totalBytes), 0),
		routeCount,
		edgeKind: "entry",
		children
	};
}
function countModules(node) {
	if (node.kind === "module") return 1 + node.children.reduce((n, c) => n + countModules(c), 0);
	return node.children.reduce((n, c) => n + countModules(c), 0);
}
function buildSideFromLoaded(loaded, side) {
	const pathRouteUsage = /* @__PURE__ */ new Map();
	for (const [route, parsed] of loaded) for (const src of parsed.attrs) {
		const bytes = side === "client" ? src.clientBytes : src.serverBytes;
		if (!src.path || bytes <= 0) continue;
		let usage = pathRouteUsage.get(src.path);
		if (!usage) {
			usage = /* @__PURE__ */ new Set();
			pathRouteUsage.set(src.path, usage);
		}
		usage.add(route);
		const pkg = packageNameFromPath(src.path);
		if (pkg) {
			let pkgUsage = pathRouteUsage.get(pkg);
			if (!pkgUsage) {
				pkgUsage = /* @__PURE__ */ new Set();
				pathRouteUsage.set(pkg, pkgUsage);
			}
			pkgUsage.add(route);
		}
	}
	const trees = {};
	const routes = [];
	for (const [route, parsed] of [...loaded.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const expanded = /* @__PURE__ */ new Set();
		const children = [];
		for (const root of parsed.roots) {
			if (root < 0 || root >= parsed.attrs.length) continue;
			children.push(walkSource(parsed.attrs, root, side, pathRouteUsage, /* @__PURE__ */ new Set(), expanded));
		}
		children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));
		let routeTotal = 0;
		for (const a of parsed.attrs) routeTotal += side === "client" ? a.clientBytes : a.serverBytes;
		const tree = {
			kind: "route",
			id: route,
			label: route,
			selfBytes: 0,
			totalBytes: routeTotal,
			routeCount: 1,
			children
		};
		trees[route] = tree;
		routes.push({
			route,
			totalBytes: routeTotal,
			moduleCount: countModules(tree)
		});
	}
	routes.sort((a, b) => b.totalBytes - a.totalBytes || a.route.localeCompare(b.route));
	return {
		routes,
		trees
	};
}
/**
* Build a viz forest from Next `experimental-analyze --output` binary data
* under `.next/diagnostics/analyze/data/` (no `analyze export` / Next 16.4+ required).
*/
function buildRouteForestFromBinary(dataDir) {
	const routeFiles = discoverRouteAnalyzeFiles(dataDir);
	const loaded = /* @__PURE__ */ new Map();
	for (const { route, filePath } of routeFiles) {
		const parsed = loadRouteSources(filePath);
		if (!parsed) continue;
		loaded.set(route, parsed);
	}
	const routesJson = join(dataDir, "routes.json");
	if (existsSync(routesJson)) try {
		const listed = JSON.parse(readFileSync(routesJson, "utf-8"));
		for (const route of listed) if (!loaded.has(route)) loaded.set(route, {
			attrs: [],
			roots: []
		});
	} catch {}
	const client = buildSideFromLoaded(loaded, "client");
	const server = buildSideFromLoaded(loaded, "server");
	client.importersByRoute = rankBinaryImportersByRoute(dataDir, "client");
	server.importersByRoute = rankBinaryImportersByRoute(dataDir, "server");
	return {
		schemaVersion: 2,
		meta: {
			snapshotName: "experimental-analyze",
			routeCount: Math.max(client.routes.length, server.routes.length),
			selectedRoutes: Math.max(client.routes.length, server.routes.length)
		},
		routes: client.routes,
		trees: client.trees,
		sides: {
			client,
			server
		}
	};
}
//#endregion
//#region src/viz.ts
async function buildVizGraph(opts) {
	if (opts.analyzeExportPath) return buildDualRouteForest(parseGraphV1File(opts.analyzeExportPath), {
		includeAsync: opts.includeAsync,
		includeTraced: opts.includeTraced
	});
	const projectRoot = opts.projectRoot ?? process.cwd();
	if (isViteProject(projectRoot)) return buildDualRouteForest(await buildGraphFromVite(projectRoot));
	const distDir = resolveDistDir(projectRoot, void 0, opts.distDir);
	const { dataDir } = resolveAnalyzeDirs(distDir);
	if (!dataDir || !existsSync(dataDir)) throw new Error(`No analyze artifacts at ${join(distDir, "diagnostics", "analyze")}. Run 'next experimental-analyze --output' (or Next 16.4+ 'next analyze --output'), or pass --analyze-export <file.jsonl.gz>.`);
	return buildRouteForestFromBinary(dataDir);
}
async function writeVizGraph(opts) {
	const viz = await buildVizGraph(opts);
	const out = resolve(opts.outputPath);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(viz, null, 2)}\n`, "utf-8");
	return viz;
}
//#endregion
//#region src/wins/binary-graph.ts
function routeClientBytes(filePath) {
	const out = /* @__PURE__ */ new Map();
	const { header, binary } = parseDataFile(readFileSync(filePath));
	const sources = header.sources ?? [];
	const parts = header.chunk_parts ?? [];
	const files = header.output_files ?? [];
	const full = buildFullPaths(sources);
	let anyClient = false;
	const per = sources.map((_, i) => {
		let comp = 0;
		let size = 0;
		for (const idx of readEdgesAtIndex(binary, header.source_chunk_parts, i)) {
			const cp = parts[idx];
			const f = files[cp?.output_file_index ?? -1]?.filename ?? "";
			if (!cp || !f.endsWith(".js") || !f.startsWith("[client-fs]/")) continue;
			anyClient = true;
			comp += cp.compressed_size;
			size += cp.size;
		}
		return comp > 0 ? comp : size;
	});
	if (!anyClient) return out;
	for (let i = 0; i < sources.length; i++) {
		const p = normalizeModulePath(full[i] ?? "");
		if (p && per[i] > 0) out.set(p, (out.get(p) ?? 0) + per[i]);
	}
	return out;
}
function newModule(ident, path) {
	return {
		type: "module",
		ident,
		path,
		dependencies: {
			sync: [],
			async: [],
			traced: []
		}
	};
}
/** Convert pre-16.4 `.next/diagnostics/analyze/data` binary artifacts into a graph-v1-shaped ParsedGraph. */
async function buildGraphFromBinary(dataDir, projectRoot) {
	const routeFiles = discoverRouteAnalyzeFiles(dataDir);
	const perRoute = /* @__PURE__ */ new Map();
	for (const { route, filePath } of routeFiles) try {
		const bytes = routeClientBytes(filePath);
		if (bytes.size > 0) perRoute.set(route, bytes);
	} catch {}
	if (perRoute.size === 0) return null;
	const modules = /* @__PURE__ */ new Map();
	const byPath = /* @__PURE__ */ new Map();
	let edgeSource = "source-graph";
	const modulesPath = join(dataDir, "modules.data");
	if (existsSync(modulesPath)) try {
		const { header, binary } = parseDataFile(readFileSync(modulesPath));
		const list = header.modules ?? [];
		const hasEdges = !!header.module_dependencies || !!header.async_module_dependencies;
		if (hasEdges) edgeSource = "modules.data";
		const idents = list.map((m, i) => `${i}:${m.ident ?? m.path ?? ""}`);
		list.forEach((m, i) => {
			const path = normalizeModulePath(m.path ?? m.ident ?? "");
			if (!path) return;
			modules.set(idents[i], newModule(idents[i], path));
			if (!byPath.has(path)) byPath.set(path, idents[i]);
		});
		if (hasEdges) list.forEach((_, i) => {
			const mod = modules.get(idents[i]);
			if (!mod) return;
			for (const d of readEdgesAtIndex(binary, header.module_dependencies, i)) if (idents[d] && modules.has(idents[d])) mod.dependencies.sync.push(idents[d]);
			for (const d of readEdgesAtIndex(binary, header.async_module_dependencies, i)) if (idents[d] && modules.has(idents[d])) mod.dependencies.async.push(idents[d]);
		});
	} catch {}
	const ensure = (path) => {
		const id = byPath.get(path);
		if (id) return modules.get(id);
		const m = newModule(path, path);
		modules.set(path, m);
		byPath.set(path, path);
		return m;
	};
	for (const bytes of perRoute.values()) for (const p of bytes.keys()) ensure(p);
	if (edgeSource === "source-graph") {
		const sg = await buildGraph(projectRoot);
		for (const [file, mod] of sg.modules) {
			const from = normalizeModulePath(relPath(projectRoot, file));
			const importer = byPath.get(from);
			if (!importer) continue;
			const deps = modules.get(importer).dependencies;
			for (const imp of mod.imports) {
				if (!imp.resolvedPath || imp.isTypeOnly) continue;
				const to = byPath.get(normalizeModulePath(relPath(projectRoot, imp.resolvedPath)));
				if (!to || to === importer) continue;
				(imp.isDynamic ? deps.async : deps.sync).push(to);
			}
		}
	}
	const routes = /* @__PURE__ */ new Map();
	const clientPartsByRoute = /* @__PURE__ */ new Map();
	const pathRouteUsage = /* @__PURE__ */ new Map();
	for (const [route, bytes] of perRoute) {
		clientPartsByRoute.set(route, bytes);
		for (const p of bytes.keys()) {
			let s = pathRouteUsage.get(p);
			if (!s) pathRouteUsage.set(p, s = /* @__PURE__ */ new Set());
			s.add(route);
		}
		const inRoute = [...modules.values()].filter((m) => bytes.has(normalizeModulePath(m.path)));
		const ids = new Set(inRoute.map((m) => m.ident));
		const hasImporter = /* @__PURE__ */ new Set();
		for (const m of inRoute) for (const d of m.dependencies.sync) if (d !== m.ident && ids.has(d)) hasImporter.add(d);
		const seeds = inRoute.filter((m) => !hasImporter.has(m.ident)).map((m) => m.ident);
		const reached = /* @__PURE__ */ new Set();
		const walk = (from) => {
			const q = [...from];
			while (q.length) {
				const id = q.pop();
				if (reached.has(id)) continue;
				reached.add(id);
				for (const d of modules.get(id)?.dependencies.sync ?? []) q.push(d);
			}
		};
		walk(seeds);
		for (const m of inRoute) if (!reached.has(m.ident)) {
			seeds.push(m.ident);
			walk([m.ident]);
		}
		routes.set(route, {
			type: "route",
			route,
			entries: [{
				route_entry_id: `${route}#client`,
				module_ident: seeds[0] ?? "",
				module_path: modules.get(seeds[0] ?? "")?.path ?? "",
				role: "route",
				entry_kind: "client_bootstrap",
				client_references: seeds.map((id) => ({
					module_ident: id,
					module_path: modules.get(id)?.path ?? "",
					reference_kind: "ecmascript"
				}))
			}],
			coverage: {
				entries: "exact",
				groups: "unknown"
			}
		});
	}
	return {
		graph: {
			meta: null,
			modules,
			routes,
			clientPartsByRoute,
			serverPartsByRoute: /* @__PURE__ */ new Map(),
			pathRouteUsage,
			serverPathRouteUsage: /* @__PURE__ */ new Map(),
			outputs: [],
			groups: []
		},
		edgeSource
	};
}
//#endregion
//#region src/wins/attribute.ts
const DEFAULT_MIN_BYTES = 2048;
/**
* uniqueBytes semantics (exact: bytes lost from the route if ONLY edge u->v is deleted):
*  - If v has another incoming sync edge p->v (or v is a route seed) where p is NOT dominated
*    by v, v stays reachable avoiding u->v => 0.
*  - Otherwise every other entry into v comes from inside v's own dominated region (e.g. a
*    back-edge in a cycle), so u->v is v's only real entry; modules dominated by v (v's
*    subtree in the dominator tree) all disappear => their attributed bytes.
* Dominators: Cooper-Harvey-Kennedy iterative algorithm over a virtual root -> seeds.
* Bytes are attributed once per normalized path (first module ident seen with that path).
*/
function attributeRoutes(graph, opts = {}) {
	const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
	const out = [];
	for (const route of [...graph.routes.keys()].sort()) out.push(attributeRoute(graph, route, minBytes));
	return out;
}
function collectSeeds(graph, route) {
	const seeds = /* @__PURE__ */ new Set();
	const entries = graph.routes.get(route)?.entries;
	if (entries) {
		const bootstraps = [];
		const refs = [];
		const routeEntries = [];
		for (const e of entries) {
			if (e.entry_kind === "client_bootstrap") bootstraps.push(e.module_ident);
			else if (e.entry_kind !== "server" && e.role === "route") routeEntries.push(e.module_ident);
			for (const r of e.client_references ?? []) if (r.reference_kind === "ecmascript") refs.push(r.module_ident);
		}
		const picked = refs.length > 0 || bootstraps.length > 0 ? [...bootstraps, ...refs] : routeEntries;
		for (const id of picked) if (id) seeds.add(id);
	}
	if (seeds.size === 0) {
		const parts = graph.clientPartsByRoute.get(route);
		if (parts) {
			for (const mod of graph.modules.values()) if (parts.has(normalizeModulePath(mod.path))) seeds.add(mod.ident);
		}
	}
	return [...seeds];
}
function attributeRoute(graph, route, minBytes) {
	const parts = graph.clientPartsByRoute.get(route);
	let firstLoadBytes = 0;
	if (parts) for (const b of parts.values()) firstLoadBytes += b;
	const result = {
		route,
		firstLoadBytes,
		measured: !!parts,
		edges: []
	};
	if (!parts) return result;
	const idents = [""];
	const index = /* @__PURE__ */ new Map();
	const succ = [[]];
	const intern = (id) => {
		let i = index.get(id);
		if (i === void 0) {
			i = idents.length;
			index.set(id, i);
			idents.push(id);
			succ.push([]);
		}
		return i;
	};
	const queue = [];
	for (const s of collectSeeds(graph, route)) {
		const had = index.has(s);
		const i = intern(s);
		if (!succ[0].includes(i)) succ[0].push(i);
		if (!had) queue.push(i);
	}
	for (let q = 0; q < queue.length; q++) {
		const u = queue[q];
		const seen = /* @__PURE__ */ new Set();
		for (const dep of graph.modules.get(idents[u])?.dependencies.sync ?? []) {
			const had = index.has(dep);
			const v = intern(dep);
			if (v === u || seen.has(v)) continue;
			seen.add(v);
			succ[u].push(v);
			if (!had) queue.push(v);
		}
	}
	const n = idents.length;
	const paths = idents.map((id) => id ? normalizeModulePath(graph.modules.get(id)?.path ?? id) : "");
	const bytes = new Array(n).fill(0);
	const counted = /* @__PURE__ */ new Set();
	for (let i = 1; i < n; i++) {
		if (counted.has(paths[i])) continue;
		counted.add(paths[i]);
		bytes[i] = parts.get(paths[i]) ?? 0;
	}
	const preds = Array.from({ length: n }, () => []);
	for (let u = 0; u < n; u++) for (const v of succ[u]) preds[v].push(u);
	const parent = new Array(n).fill(-1);
	parent[0] = 0;
	const bfs = [0];
	for (let q = 0; q < bfs.length; q++) for (const v of succ[bfs[q]]) if (parent[v] === -1) {
		parent[v] = bfs[q];
		bfs.push(v);
	}
	const post = new Array(n).fill(-1);
	const order = [];
	const visited = new Array(n).fill(false);
	const stack = [[0, 0]];
	visited[0] = true;
	while (stack.length) {
		const top = stack[stack.length - 1];
		const s = succ[top[0]];
		if (top[1] < s.length) {
			const v = s[top[1]++];
			if (!visited[v]) {
				visited[v] = true;
				stack.push([v, 0]);
			}
		} else {
			post[top[0]] = order.length;
			order.push(top[0]);
			stack.pop();
		}
	}
	const idom = new Array(n).fill(-1);
	idom[0] = 0;
	const intersect = (a, b) => {
		while (a !== b) {
			while (post[a] < post[b]) a = idom[a];
			while (post[b] < post[a]) b = idom[b];
		}
		return a;
	};
	for (let changed = true; changed;) {
		changed = false;
		for (let k = order.length - 2; k >= 0; k--) {
			const b = order[k];
			let nd = -1;
			for (const p of preds[b]) {
				if (idom[p] === -1) continue;
				nd = nd === -1 ? p : intersect(p, nd);
			}
			if (nd !== idom[b]) {
				idom[b] = nd;
				changed = true;
			}
		}
	}
	const domBytes = bytes.slice();
	for (const v of order) if (v !== 0) domBytes[idom[v]] += domBytes[v];
	const reach = /* @__PURE__ */ new Map();
	const subtreeBytes = (v) => {
		let r = reach.get(v);
		if (r !== void 0) return r;
		const seen = new Set([v]);
		const st = [v];
		r = 0;
		while (st.length) {
			const x = st.pop();
			r += bytes[x];
			for (const y of succ[x]) if (!seen.has(y)) {
				seen.add(y);
				st.push(y);
			}
		}
		reach.set(v, r);
		return r;
	};
	const chainTo = (v) => {
		const c = [];
		for (let x = v; x !== 0; x = parent[x]) c.push(paths[x]);
		return c.reverse();
	};
	const dominates = (a, b) => {
		for (let x = b;; x = idom[x]) {
			if (x === a) return true;
			if (x === 0) return false;
		}
	};
	const edges = [];
	for (let u = 1; u < n; u++) {
		if (parent[u] === -1) continue;
		for (const v of succ[u]) {
			if (!preds[v].every((p) => p === u || dominates(v, p))) continue;
			const uniqueBytes = domBytes[v];
			if (uniqueBytes < minBytes || uniqueBytes <= 0) continue;
			edges.push({
				edge: {
					importer: paths[u],
					imported: paths[v],
					packageName: packageNameFromPath(paths[v])
				},
				chain: [...chainTo(u), paths[v]],
				uniqueBytes,
				subtreeBytes: subtreeBytes(v)
			});
		}
	}
	edges.sort((a, b) => b.uniqueBytes - a.uniqueBytes || a.edge.imported.localeCompare(b.edge.imported));
	result.edges = edges;
	return result;
}
//#endregion
//#region src/wins/usage-analyze.ts
const FN_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression"
]);
const TYPE_ANCESTORS = /^TS(TypeAnnotation|TypeReference|TypeAliasDeclaration|InterfaceDeclaration|TypeQuery|TypeParameter)/;
const TRANSPARENT_METHODS = new Set([
	"map",
	"flatMap",
	"filter",
	"reduce",
	"find",
	"some",
	"every"
]);
const TRANSPARENT_HOOKS = new Set([
	"useMemo",
	"useState",
	"useReducer",
	"useRef",
	"useSyncExternalStore"
]);
const stripExt = (p) => p.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, "").replace(/\/index$/, "");
function matchesEdge(spec, importer, edge) {
	if (edge.packageName) {
		if (getPackageName(spec) === edge.packageName) return true;
		return false;
	}
	const target = stripExt(edge.imported);
	if (spec.startsWith(".")) return stripExt(posix.normalize(posix.join(dirname(importer), spec))) === target;
	const tail = stripExt(spec.replace(/^[@~#]\/?/, ""));
	return tail.length > 0 && (target === tail || target.endsWith("/" + tail));
}
function collectRefs(root, names) {
	const refs = [];
	const stack = [];
	const visit = (node) => {
		if (node.type === "ImportDeclaration") return;
		const parent = stack[stack.length - 1];
		if ((node.type === "Identifier" || node.type === "JSXIdentifier") && names.has(node.name)) {
			let ok = true;
			if (parent) {
				if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ok = false;
				else if (parent.type === "JSXMemberExpression" && parent.property === node) ok = false;
				else if (parent.type === "JSXAttribute" || parent.type === "JSXClosingElement") ok = false;
				else if ((parent.type === "Property" || parent.type === "PropertyDefinition") && parent.key === node && !parent.shorthand && !parent.computed) ok = false;
			}
			if (ok && !stack.some((a) => TYPE_ANCESTORS.test(a.type))) refs.push({
				node,
				ancestors: [...stack],
				jsx: node.type === "JSXIdentifier"
			});
		}
		stack.push(node);
		for (const key of Object.keys(node)) {
			const val = node[key];
			if (!val || typeof val !== "object") continue;
			if (Array.isArray(val)) {
				for (const c of val) if (c && typeof c === "object" && "type" in c) visit(c);
			} else if ("type" in val) visit(val);
		}
		stack.pop();
	};
	visit(root);
	return refs;
}
const isHandlerAttr = (n) => n.type === "JSXAttribute" && n.name?.type === "JSXIdentifier" && /^on[A-Z]/.test(n.name.name);
/** Is this function (with ancestors above it) executed outside render and clearly a handler/callback? */
function deferredKind(fn, parent, grand) {
	if (parent?.type === "CallExpression" && parent.arguments?.includes(fn)) {
		const callee = parent.callee;
		if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier" && TRANSPARENT_METHODS.has(callee.property.name)) return "transparent";
		if (callee?.type === "Identifier" && TRANSPARENT_HOOKS.has(callee.name)) return "transparent";
		return "handler";
	}
	if (parent?.type === "JSXExpressionContainer" && grand && isHandlerAttr(grand)) return "handler";
	if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier" && /^(on|handle|set|toggle|open|close|submit)/i.test(parent.id.name)) return "handler";
	if (fn.type === "FunctionDeclaration" && /^(on|handle)/i.test(fn.id?.name ?? "")) return "handler";
	return "other";
}
function classifyRef(ref) {
	const chain = [...ref.ancestors, ref.node];
	const fnIdx = [];
	chain.forEach((n, i) => {
		if (FN_TYPES.has(n.type)) fnIdx.push(i);
	});
	if (fnIdx.length === 0) return "always-rendered";
	let start = fnIdx[0];
	let deferred = null;
	for (const i of fnIdx.slice(1)) {
		const k = deferredKind(chain[i], chain[i - 1], chain[i - 2]);
		if (k === "transparent") continue;
		deferred = k;
		start = i;
		break;
	}
	if (deferred === "handler") return "event-handler-only";
	if (deferred === "other") return ref.jsx ? "unknown" : "event-handler-only";
	for (let i = chain.length - 2; i > start; i--) {
		const n = chain[i];
		const child = chain[i + 1];
		if (isHandlerAttr(n)) return "event-handler-only";
		if (n.type === "ConditionalExpression" && n.test !== child) return "conditional-render";
		if (n.type === "LogicalExpression" && n.right === child) return "conditional-render";
		if (n.type === "IfStatement" && n.test !== child) return "conditional-render";
		if (n.type === "SwitchCase" && n.test !== child) return "conditional-render";
	}
	return "always-rendered";
}
function jsxName(n) {
	if (!n) return "";
	if (n.type === "JSXIdentifier") return n.name;
	if (n.type === "JSXMemberExpression") return n.property?.name ?? "";
	return "";
}
function inSuspense(ref) {
	return ref.ancestors.some((a) => a.type === "JSXElement" && jsxName(a.openingElement?.name) === "Suspense");
}
function parseSource(file, source) {
	return parseSync(file, source, { sourceType: "module" });
}
/** Cheap structural facts about an (imported) local module. */
function moduleFacts(file, source) {
	const { program } = parseSource(file, source);
	let hasDefault = false;
	for (const s of program.body) {
		const n = toAst(s);
		if (n.type === "ExportDefaultDeclaration") hasDefault = true;
		if (n.type === "ExportNamedDeclaration") {
			for (const sp of n.specifiers ?? []) if ((sp.exported?.name ?? sp.exported?.value) === "default") hasDefault = true;
		}
	}
	return {
		hasDefault,
		isClient: extractDirectives(program).has("use client"),
		signals: extractSignals(source, program)
	};
}
function analyzeImportUsage(importerPath, source, edge) {
	const empty = {
		usage: "unknown",
		bindings: [],
		specifier: "",
		originalImport: "",
		typeOnly: false,
		isClient: false,
		inSuspense: false,
		isPageOrLayout: false,
		found: false,
		unused: false
	};
	let program;
	try {
		program = parseSource(importerPath, source).program;
	} catch {
		return empty;
	}
	const lines = source.split("\n");
	const isClient = extractDirectives(program).has("use client");
	const base = importerPath.split("/").pop().replace(/\.[^.]+$/, "");
	const isPageOrLayout = base === "page" || base === "layout";
	let decl = null;
	for (const s of program.body) {
		const n = toAst(s);
		if (n.type === "ImportDeclaration" && matchesEdge(n.source?.value ?? "", importerPath, edge)) {
			decl = n;
			break;
		}
	}
	if (!decl) return {
		...empty,
		isClient,
		isPageOrLayout
	};
	const bindings = [];
	for (const sp of decl.specifiers ?? []) {
		if (sp.importKind === "type") continue;
		const local = sp.local?.name;
		if (sp.type === "ImportDefaultSpecifier") bindings.push({
			local,
			kind: "default",
			imported: "default"
		});
		else if (sp.type === "ImportNamespaceSpecifier") bindings.push({
			local,
			kind: "namespace",
			imported: "*"
		});
		else bindings.push({
			local,
			kind: "named",
			imported: sp.imported?.name ?? sp.imported?.value ?? local
		});
	}
	const res = {
		...empty,
		found: true,
		isClient,
		isPageOrLayout,
		bindings,
		specifier: decl.source.value,
		originalImport: source.slice(decl.start, decl.end),
		typeOnly: decl.importKind === "type"
	};
	if (res.typeOnly) return res;
	if (bindings.length === 0) return res;
	const refs = collectRefs(toAst(program), new Set(bindings.map((b) => b.local)));
	if (refs.length === 0) {
		res.unused = true;
		return res;
	}
	const kinds = refs.map(classifyRef);
	if (kinds.includes("always-rendered")) res.usage = "always-rendered";
	else if (kinds.includes("unknown")) res.usage = "unknown";
	else if (kinds.includes("conditional-render")) res.usage = "conditional-render";
	else res.usage = "event-handler-only";
	const pickIdx = kinds.findIndex((k) => k === res.usage);
	const pick = refs[pickIdx >= 0 ? pickIdx : 0];
	const loc = locFromOffset(pick.node.start ?? pick.node.span?.start ?? 0, lines);
	res.usageLoc = {
		line: loc.line,
		column: loc.column
	};
	res.inSuspense = refs.some(inSuspense);
	return res;
}
//#endregion
//#region src/wins/classify.ts
function detectFramework(projectRoot) {
	try {
		const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
		const deps = {
			...pkg.dependencies,
			...pkg.devDependencies
		};
		for (const [dep, fw] of [
			["next", "next"],
			["solid-js", "solid"],
			["vue", "vue"],
			["svelte", "svelte"],
			["react", "react"],
			["preact", "react"]
		]) if (deps[dep]) return fw;
	} catch {}
	return "generic";
}
const DROP_BELOW_BYTES = 10 * 1024;
/**
* Merge identical (importer, imported) edges across routes.
* routes[route] = max uniqueBytes seen for that route; totalSavedBytes = max over routes
* (a shared chunk is downloaded once, so fixing all routes can't save more than the largest single-route saving
* when the chunk is shared; this is a conservative lower bound versus summing).
*/
function mergeEdges(attributions) {
	const groups = /* @__PURE__ */ new Map();
	for (const attr of attributions) for (const cut of attr.edges) {
		if (!isAppSourcePath(cut.edge.importer)) continue;
		if (cut.edge.packageName && FRAMEWORK.has(cut.edge.packageName)) continue;
		const key = `${cut.edge.importer}\0${cut.edge.imported}`;
		let g = groups.get(key);
		if (!g) {
			g = {
				cut,
				routes: {}
			};
			groups.set(key, g);
		} else if (cut.chain.length < g.cut.chain.length) g.cut = {
			...cut,
			loc: cut.loc ?? g.cut.loc
		};
		g.routes[attr.route] = Math.max(g.routes[attr.route] ?? 0, cut.uniqueBytes);
	}
	return dedupeChains([...groups.values()]);
}
/** Packages the app can't meaningfully cut (framework runtime). */
const FRAMEWORK = new Set([
	"next",
	"react",
	"react-dom",
	"scheduler"
]);
const CHAIN_TOLERANCE = .05;
/**
* Chain dedupe: if edge A (ancestor) lies on the import chain leading to edge B (descendant) in a
* shared route, and B saves within 5% of A's bytes, cutting either saves the same thing, so keep
* only the deepest (B) and drop A. If A saves meaningfully more than B (>5%), keep both.
*/
function dedupeChains(groups) {
	const isPrefix = (a, b) => a.length < b.length && a.every((x, i) => x === b[i]);
	const total = (g) => Math.max(0, ...Object.values(g.routes));
	return groups.filter((a) => {
		const ta = total(a);
		return !groups.some((b) => b !== a && isPrefix(a.cut.chain, b.cut.chain) && Object.keys(a.routes).some((r) => r in b.routes) && total(b) >= ta * (1 - CHAIN_TOLERANCE));
	});
}
async function readText(path) {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return null;
	}
}
const isIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s);
const LAZY_IMPORT = {
	react: `import { lazy } from 'react';`,
	solid: `import { lazy } from 'solid-js';`,
	vue: `import { defineAsyncComponent } from 'vue';`
};
/** Lazy component declarations; non-Next frameworks expect a { default } module shape. */
function lazyDecls(u, opts, fw) {
	return u.bindings.map((b) => {
		const spec = `'${u.specifier}'`;
		const named = b.kind === "named" ? isIdent(b.imported) ? `m.${b.imported}` : `m["${b.imported}"]` : null;
		if (fw === "next") {
			const expr = named ? `import(${spec}).then((m) => ${named})` : `import(${spec})`;
			return `const ${b.local} = dynamic(() => ${expr}, ${opts});`;
		}
		const expr = named ? `import(${spec}).then((m) => ({ default: ${named} }))` : `import(${spec})`;
		if (fw === "vue") return `const ${b.local} = defineAsyncComponent(() => ${expr});`;
		if (fw === "react" || fw === "solid") return `const ${b.local} = lazy(() => ${expr});`;
		return `const ${b.local} = () => ${named ? `import(${spec}).then((m) => ${named})` : `import(${spec})`};`;
	});
}
function handlerImport(u) {
	return u.bindings.map((b) => b.kind === "default" ? `const { default: ${b.local} } = await import('${u.specifier}');` : b.kind === "named" ? `const { ${b.imported === b.local ? b.local : `${b.imported}: ${b.local}`} } = await import('${u.specifier}');` : `const ${b.local} = await import('${u.specifier}');`).join("\n");
}
async function classifyWins(attributions, ctx) {
	const data = loadDataTables();
	const replacements = loadReplacements();
	const groups = mergeEdges(attributions);
	const byImported = /* @__PURE__ */ new Map();
	for (const g of groups) {
		const arr = byImported.get(g.cut.edge.imported) ?? [];
		arr.push(g);
		byImported.set(g.cut.edge.imported, arr);
	}
	const wins = [];
	for (const g of groups) {
		const { edge } = g.cut;
		const routeNames = Object.keys(g.routes);
		const total = Math.max(0, ...Object.values(g.routes));
		const importerAbs = join(ctx.projectRoot, edge.importer);
		const importerSrc = edge.importer.startsWith("node_modules/") ? null : await readText(importerAbs);
		const u = importerSrc ? analyzeImportUsage(edge.importer, importerSrc, edge) : null;
		const usage = u?.found ? u.usage : "unknown";
		const reasons = /* @__PURE__ */ new Set();
		const isPackage = !!edge.packageName;
		let facts = null;
		if (!isPackage) {
			const src = await readText(join(ctx.projectRoot, edge.imported));
			if (src) try {
				facts = moduleFacts(edge.imported, src);
			} catch {
				facts = null;
			}
		}
		const isRemove = !!u?.found && u.unused && u.bindings.length > 0;
		const namedFromRoot = isPackage && !!u?.found && u.specifier === edge.packageName && u.bindings.some((b) => b.kind === "named");
		const swapTarget = isPackage ? replacements.get(edge.packageName) : void 0;
		const isHeavy = isPackage && data.heavyPackages.has(edge.packageName);
		const deferredUse = usage === "conditional-render" || usage === "event-handler-only";
		let fixKind = null;
		if (isRemove) fixKind = "remove";
		else if (namedFromRoot && data.barrelPackages.has(edge.packageName)) fixKind = "deep-import";
		else if (isPackage && (isHeavy || swapTarget) && !deferredUse) fixKind = "swap-package";
		else if (!isPackage && u?.found && u.isClient && facts && !facts.isClient && facts.signals.hooks.length === 0 && facts.signals.eventHandlers.length === 0 && facts.signals.browserGlobals.length === 0 && (usage === "always-rendered" || usage === "unknown")) fixKind = "move-to-server";
		else if (deferredUse) fixKind = "lazy";
		const determined = fixKind !== null;
		if (!fixKind) {
			if (usage === "unknown" && total < DROP_BELOW_BYTES) continue;
			fixKind = "lazy";
		}
		if (fixKind === "lazy") {
			if (usage === "always-rendered" && u?.isPageOrLayout) reasons.add("above-the-fold");
			if (usage === "always-rendered") reasons.add("needs-ssr");
			if (u?.found && u.inSuspense) reasons.add("already-in-suspense");
			if (u?.found && u.bindings.some((b) => b.kind === "named")) reasons.add("named-export");
			if (facts && !facts.hasDefault) reasons.add("no-default-export");
		}
		if (usage === "unknown" && fixKind !== "remove") reasons.add("unresolved-usage");
		if (!determined && usage === "always-rendered" && !u?.isPageOrLayout) reasons.add("needs-ssr");
		if ((byImported.get(edge.imported) ?? []).filter((o) => o !== g && o.cut.edge.importer !== edge.importer && routeNames.some((r) => r in o.routes)).length > 0) reasons.add("shared-with-eager-route");
		const edit = buildEdit(fixKind, usage, u, edge, ctx, routeNames, swapTarget?.replacement);
		wins.push({
			id: `${fixKind}:${edge.importer}:${edge.imported}`,
			fixKind,
			safety: reasons.size === 0 ? "safe" : "needs-review",
			safetyReasons: [...reasons],
			usage,
			edge,
			loc: g.cut.loc,
			usageLoc: u?.usageLoc,
			routes: g.routes,
			totalSavedBytes: total,
			byteSource: ctx.byteSource,
			chain: g.cut.chain,
			edit
		});
	}
	wins.sort((a, b) => b.totalSavedBytes - a.totalSavedBytes || (a.safety === b.safety ? 0 : a.safety === "safe" ? -1 : 1) || a.id.localeCompare(b.id));
	return wins;
}
function buildEdit(fixKind, usage, u, edge, ctx, routes, replacement) {
	const target = edge.packageName ?? edge.imported;
	const verify = `pnpm exec wimb wins --cwd ${JSON.stringify(ctx.projectRoot)} --compare  # rebuild + compare routes: ${routes.join(", ")}`;
	const original = u?.found ? u.originalImport : void 0;
	const file = edge.importer;
	const names = u?.bindings.map((b) => b.local).join(", ") ?? "";
	switch (fixKind) {
		case "remove": return {
			summary: `Remove unused import of ${target} from ${file}`,
			originalImport: original,
			steps: [`Delete the import of ${target} in ${file}.`, "Remove any now-unused dependency from package.json."],
			verify
		};
		case "deep-import": return {
			summary: `Import ${names} from ${target} subpaths instead of the package root`,
			originalImport: original,
			replacementImport: `import X from '${target}/<symbol-path>'`,
			steps: [`In ${file}, replace the root import of ${target} with per-symbol deep imports.`, "Check the package's exports map for the correct subpath."],
			verify
		};
		case "swap-package": return {
			summary: replacement ? `Replace ${target} with ${replacement}` : `Replace heavy package ${target} with a lighter alternative`,
			originalImport: original,
			replacementImport: replacement ? `// use ${replacement}` : void 0,
			steps: [replacement ? `Replace usages of ${target} in ${file} with ${replacement}.` : `Pick a lighter alternative to ${target} (or a smaller entrypoint) and update ${file}.`, `Remove ${target} from package.json if no other importers remain.`],
			verify
		};
		case "move-to-server": return {
			summary: `Render ${edge.imported} from a Server Component instead of the "use client" file ${file}`,
			originalImport: original,
			steps: [`${edge.imported} uses no hooks, handlers or browser globals.`, `Move the render of ${names} to a parent Server Component and pass it into ${file} as children/props.`],
			verify
		};
		case "lazy": {
			if (!u?.found || u.bindings.length === 0) return {
				summary: `Defer loading of ${target} from ${file}`,
				originalImport: original,
				steps: [`Load ${target} lazily in ${file} (next/dynamic, lazy(), or dynamic import()).`],
				verify
			};
			if (usage === "event-handler-only") return {
				summary: `Load ${target} on demand inside the handler in ${file}`,
				originalImport: original,
				replacementImport: handlerImport(u),
				steps: [
					`Remove the static import in ${file}.`,
					"Make the handler async and add the dynamic import at its start.",
					"Use the destructured bindings after the await."
				],
				verify
			};
			const fw = ctx.framework ?? "next";
			const ssrFalse = fw === "next" && usage !== "always-rendered" && (u.isClient || !u.isPageOrLayout);
			const opts = ssrFalse ? "{ ssr: false, loading: () => null }" : "{ loading: () => null }";
			const stepsNamed = u.bindings.some((b) => b.kind === "named");
			const helper = {
				next: "next/dynamic",
				react: "React.lazy",
				solid: "solid-js lazy",
				vue: "defineAsyncComponent",
				svelte: "dynamic import()",
				generic: "dynamic import()"
			}[fw];
			const header = fw === "next" ? [`import dynamic from 'next/dynamic';`] : LAZY_IMPORT[fw] ? [LAZY_IMPORT[fw]] : [];
			const boundary = fw === "react" || fw === "solid" ? [`Wrap the rendered component in <Suspense fallback={...}> (${fw === "solid" ? "solid-js" : "react"}).`] : fw === "vue" ? ["Optionally pass { loadingComponent } to defineAsyncComponent or wrap in <Suspense>."] : [];
			return {
				summary: `Lazy-load ${target} with ${helper} in ${file}`,
				originalImport: original,
				replacementImport: [...header, ...lazyDecls(u, opts, fw)].join("\n"),
				steps: [
					`Replace the static import in ${file} with the ${helper} form.`,
					...stepsNamed ? [fw === "next" ? "Named export: the .then(m => m.X) mapping selects the export." : "Named export: the .then(m => ({ default: m.X })) mapping adapts it to a default export."] : [],
					...boundary,
					"If the binding is a value (not a component), `await import()` it where first used instead.",
					...fw === "next" ? [ssrFalse ? "ssr:false is safe because the component renders only conditionally." : "Keep SSR enabled (above-the-fold content); consider a sized loading placeholder to avoid layout shift."] : [],
					"Confirm no layout shift when the component appears."
				],
				verify
			};
		}
	}
}
//#endregion
//#region src/wins/index.ts
const NO_DATA_MESSAGE = "No measured analyze data found. Run 'next analyze' (Next 16.4+) in the project first, or pass --analyze-export <file.jsonl[.gz]>.";
function exportJsonl(projectRoot, distDir, snapshot) {
	const args = [
		"analyze",
		"export",
		"--dist-dir",
		distDir
	];
	if (snapshot) args.push("--snapshot", snapshot);
	const local = join(projectRoot, "node_modules", ".bin", "next");
	const [command, fullArgs] = existsSync(local) ? [local, args] : ["npx", ["next", ...args]];
	return new Promise((resolve, reject) => {
		const child = spawn(command, fullArgs, {
			cwd: projectRoot,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				TURBOPACK: "1"
			}
		});
		let out = "";
		let err = "";
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (c) => out += c);
		child.stderr?.on("data", (c) => err = (err + String(c)).slice(-4e3));
		child.on("error", (e) => reject(e));
		child.on("close", (code) => code === 0 ? resolve(out) : reject(/* @__PURE__ */ new Error(`next analyze export failed (exit ${code})\n${err.trim()}`)));
	});
}
function runNextAnalyze(projectRoot, snapshot) {
	const args = [
		"analyze",
		"--output",
		"--snapshot",
		snapshot
	];
	const local = join(projectRoot, "node_modules", ".bin", "next");
	const [command, fullArgs] = existsSync(local) ? [local, args] : ["npx", ["next", ...args]];
	return new Promise((resolve, reject) => {
		const child = spawn(command, fullArgs, {
			cwd: projectRoot,
			stdio: [
				"ignore",
				"inherit",
				"inherit"
			]
		});
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(/* @__PURE__ */ new Error(`next analyze failed (exit ${code})`)));
	});
}
async function loadGraph(opts) {
	if (opts.analyzeExportPath) {
		if (!existsSync(opts.analyzeExportPath)) throw new Error(`analyze export not found at ${opts.analyzeExportPath}`);
		return parseGraphV1File(opts.analyzeExportPath);
	}
	if (opts.vite ?? isViteProject(opts.projectRoot)) return buildGraphFromVite(opts.projectRoot);
	const distDir = resolveDistDir(opts.projectRoot, (await parseNextConfig(opts.projectRoot))?.distDir, opts.distDir);
	if (!hasAnalyzeArtifacts(distDir) || !projectSupportsAnalyzeExport(opts.projectRoot)) {
		const dataDir = resolveAnalyzeDirs(distDir).dataDir;
		const bin = dataDir ? await buildGraphFromBinary(dataDir, opts.projectRoot) : null;
		if (bin) return bin.graph;
		throw new Error(NO_DATA_MESSAGE);
	}
	return parseGraphV1Jsonl(await exportJsonl(opts.projectRoot, distDir, opts.snapshot));
}
async function runWins(opts) {
	const attributions = attributeRoutes(await loadGraph(opts), { minBytes: opts.minBytes });
	if (attributions.length === 0) throw new Error(NO_DATA_MESSAGE);
	const wins = await classifyWins(attributions, {
		projectRoot: opts.projectRoot,
		byteSource: "measured",
		framework: detectFramework(opts.projectRoot)
	});
	return {
		version: "2",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		projectRoot: opts.projectRoot,
		byteSource: "measured",
		routes: attributions.map((a) => ({
			route: a.route,
			firstLoadBytes: a.firstLoadBytes
		})),
		wins
	};
}
//#endregion
//#region src/wins/output.ts
const kb = (n) => (n / 1024).toFixed(1);
function locOf(w) {
	return `${w.edge.importer}${w.loc ? `:${w.loc.line}` : ""}`;
}
function shortPath(p, max = 60) {
	const idx = p.lastIndexOf("node_modules/");
	let s = idx >= 0 ? p.slice(idx + 13) : p;
	if (s.length > max) {
		const keep = max - 1;
		const head = Math.ceil(keep / 2);
		s = `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
	}
	return s;
}
function shortLoc(w) {
	return `${shortPath(w.edge.importer, 40)}${w.loc ? `:${w.loc.line}` : ""} -> ${shortPath(w.edge.imported, 40)}`;
}
const COLORS = {
	safe: "\x1B[32m",
	"needs-review": "\x1B[33m"
};
function table(rows, colorSafetyCol, color = false) {
	const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
	return rows.map((r) => r.map((cell, c) => {
		const padded = c === r.length - 1 ? cell : cell.padEnd(widths[c]);
		const code = color && c === colorSafetyCol ? COLORS[cell] : void 0;
		return code ? `${code}${padded}\x1b[0m` : padded;
	}).join("  ").trimEnd());
}
function writeWins(root, report) {
	const dir = join(root, ".wimb");
	mkdirSync(dir, { recursive: true });
	const jsonPath = join(dir, "wins.json");
	const mdPath = join(dir, "wins.md");
	writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
	writeFileSync(mdPath, formatWinsMarkdown(report), "utf-8");
	return {
		jsonPath,
		mdPath
	};
}
function formatWinsTerminal(report, opts = {}) {
	const top = opts.top ?? 10;
	const lines = [];
	lines.push("Route first-load JS:");
	for (const r of report.routes) lines.push(`  ${r.route}  ${kb(r.firstLoadBytes)} KB`);
	lines.push("");
	const wins = report.wins.slice(0, top);
	if (wins.length === 0) {
		lines.push("No wins found.");
		return lines.join("\n");
	}
	const firstLoad = new Map(report.routes.map((r) => [r.route, r.firstLoadBytes]));
	const rows = [[
		"#",
		"KB saved",
		"%",
		"fix",
		"safety",
		"pkg",
		"location",
		"routes"
	]];
	wins.forEach((w, i) => {
		const top = Object.entries(w.routes).sort((a, b) => b[1] - a[1])[0];
		const total = top ? firstLoad.get(top[0]) : void 0;
		const pct = top && total ? `${(top[1] / total * 100).toFixed(1)}%` : "-";
		rows.push([
			String(i + 1),
			kb(w.totalSavedBytes),
			pct,
			w.fixKind,
			w.safety,
			w.edge.packageName ?? "app",
			shortLoc(w),
			String(Object.keys(w.routes).length)
		]);
	});
	lines.push(...table(rows, 4, !!process.stdout.isTTY));
	if (report.wins.length > top) lines.push(`... ${report.wins.length - top} more (see .wimb/wins.md)`);
	return lines.join("\n");
}
function formatWinsMarkdown(report) {
	const out = [];
	out.push("# wimb wins", "");
	out.push(`Byte source: ${report.byteSource}`, "");
	out.push("## Route first-load JS", "", "| Route | First load (KB) |", "| --- | ---: |");
	for (const r of report.routes) out.push(`| ${r.route} | ${kb(r.firstLoadBytes)} |`);
	out.push("", "## Top wins", "");
	if (report.wins.length === 0) {
		out.push("No wins found.", "");
		return out.join("\n");
	}
	out.push("| # | KB saved | Fix | Safety | Pkg | Location | Routes |", "| ---: | ---: | --- | --- | --- | --- | ---: |");
	report.wins.forEach((w, i) => {
		out.push(`| ${i + 1} | ${kb(w.totalSavedBytes)} | ${w.fixKind} | ${w.safety} | ${w.edge.packageName ?? "app"} | \`${shortLoc(w)}\` | ${Object.keys(w.routes).length} |`);
	});
	out.push("", "## Details", "");
	report.wins.forEach((w, i) => {
		out.push(`### ${i + 1}. ${w.edge.imported} (${kb(w.totalSavedBytes)} KB, ${w.fixKind}, ${w.safety})`, "");
		out.push(`- Location: \`${locOf(w)}\``);
		if (w.safetyReasons.length) out.push(`- Reasons: ${w.safetyReasons.join(", ")}`);
		out.push(`- Usage: ${w.usage}`);
		out.push(`- Routes: ${Object.entries(w.routes).map(([r, b]) => `${r} (${kb(b)} KB)`).join(", ")}`);
		out.push(`- Chain: ${w.chain.join(" -> ")}`, "");
		out.push(w.edit.summary, "");
		if (w.edit.originalImport) out.push("```ts", `- ${w.edit.originalImport}`, ...w.edit.replacementImport ? [`+ ${w.edit.replacementImport}`] : [], "```", "");
		else if (w.edit.replacementImport) out.push("```ts", w.edit.replacementImport, "```", "");
		if (w.edit.steps.length) out.push(...w.edit.steps.map((s, n) => `${n + 1}. ${s}`), "");
		out.push(`Verify: \`${w.edit.verify}\``, "");
	});
	return out.join("\n");
}
//#endregion
//#region src/wins/compare.ts
function compareWins(before, after) {
	const b = new Map(before.routes.map((r) => [r.route, r.firstLoadBytes]));
	const a = new Map(after.routes.map((r) => [r.route, r.firstLoadBytes]));
	const routes = [];
	for (const route of [...new Set([...b.keys(), ...a.keys()])].sort()) {
		if (!b.has(route) || !a.has(route)) continue;
		const bb = b.get(route);
		const aa = a.get(route);
		routes.push({
			route,
			before: bb,
			after: aa,
			delta: aa - bb
		});
	}
	const beforeIds = new Set(before.wins.map((w) => w.id));
	const afterIds = new Set(after.wins.map((w) => w.id));
	return {
		routes,
		resolved: before.wins.filter((w) => !afterIds.has(w.id)),
		introduced: after.wins.filter((w) => !beforeIds.has(w.id))
	};
}
function checkBudget(report, opts) {
	const out = [];
	if (opts.routeBudgetBytes != null) {
		for (const r of report.routes) if (r.firstLoadBytes > opts.routeBudgetBytes) out.push({
			kind: "route-over-budget",
			message: `${r.route}: ${r.firstLoadBytes} bytes first-load exceeds budget ${opts.routeBudgetBytes}`
		});
	}
	if (opts.maxSafeWinBytes != null) {
		const safe = report.wins.filter((w) => w.safety === "safe").reduce((s, w) => s + w.totalSavedBytes, 0);
		if (safe > opts.maxSafeWinBytes) out.push({
			kind: "safe-wins-over-limit",
			message: `${safe} bytes of safe wins available exceeds limit ${opts.maxSafeWinBytes}`
		});
	}
	return out;
}
//#endregion
//#region src/index.ts
runMain(defineCommand({
	meta: {
		name: "wimb",
		description: "Where Is My Banana — Next.js client bloat detector"
	},
	subCommands: {
		scan: defineCommand({
			meta: {
				name: "scan",
				description: "Scan a Next.js App Router project for client bloat"
			},
			args: {
				cwd: {
					type: "string",
					description: "Project root",
					default: process.cwd()
				},
				build: {
					type: "boolean",
					description: "Deep scan with next analyze (measured bytes). Next 16.4+ uses `next analyze export`.",
					default: false
				},
				"dist-dir": {
					type: "string",
					description: "Override distDir / point at pre-built analyze output"
				},
				snapshot: {
					type: "string",
					description: "Named next analyze snapshot to capture or export (Next 16.4+)"
				},
				"analyze-export": {
					type: "string",
					description: "Read measured bytes from a next analyze export JSONL file (.jsonl or .jsonl.gz)"
				},
				format: {
					type: "string",
					description: "Output formats: json,md (comma-separated)",
					default: "json,md"
				},
				"exit-threshold": {
					type: "string",
					description: "Exit 1 if findings at or above this severity",
					default: "error"
				},
				"forest-compact": {
					type: "boolean",
					description: "Omit AST and JSX trees from forest.json entries",
					default: false
				},
				"no-ast": {
					type: "boolean",
					description: "Alias for --forest-compact",
					default: false
				}
			},
			async run({ args }) {
				const projectRoot = resolve(args.cwd);
				const formats = args.format.split(",").map((s) => s.trim());
				const code = await scan({
					projectRoot,
					build: args.build,
					distDir: args["dist-dir"],
					snapshot: args.snapshot,
					analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : void 0,
					formats,
					exitThreshold: args["exit-threshold"],
					forestCompact: args["forest-compact"] || args["no-ast"]
				});
				process.exit(code);
			}
		}),
		viz: defineCommand({
			meta: {
				name: "viz",
				description: "Build payloads for the WIMB bundle forest visualizer"
			},
			subCommands: { build: defineCommand({
				meta: {
					name: "build",
					description: "Build a route-rooted import forest JSON from next analyze export OR experimental-analyze binary artifacts"
				},
				args: {
					"analyze-export": {
						type: "string",
						description: "Path to next analyze export JSONL (.jsonl or .jsonl.gz). Optional if binary analyze data exists."
					},
					"dist-dir": {
						type: "string",
						description: "App distDir with diagnostics/analyze (default .next). Used when --analyze-export is omitted."
					},
					output: {
						type: "string",
						description: "Output path for viz graph JSON",
						default: ".wimb/bundle-graph.json"
					},
					cwd: {
						type: "string",
						description: "App / project root (binary path lookup + relative paths)",
						default: process.cwd()
					},
					async: {
						type: "boolean",
						description: "Include async dependency edges (export JSONL only)",
						default: false
					},
					traced: {
						type: "boolean",
						description: "Include traced dependency edges (export JSONL only)",
						default: false
					}
				},
				async run({ args }) {
					const projectRoot = resolve(args.cwd);
					const outputPath = resolve(projectRoot, args.output);
					const viz = await writeVizGraph({
						analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : void 0,
						projectRoot,
						distDir: args["dist-dir"] ?? (await parseNextConfig(projectRoot))?.distDir,
						outputPath,
						includeAsync: args.async,
						includeTraced: args.traced
					});
					console.log(`wimb: wrote ${outputPath} (${viz.routes.length} routes, snapshot ${viz.meta.snapshotName ?? "unknown"})`);
				}
			}) }
		}),
		wins: defineCommand({
			meta: {
				name: "wins",
				description: "Rank import edges whose removal shrinks first-load client JS"
			},
			args: {
				cwd: {
					type: "string",
					description: "Project root",
					default: process.cwd()
				},
				"analyze-export": {
					type: "string",
					description: "next analyze export JSONL (.jsonl or .jsonl.gz)"
				},
				"dist-dir": {
					type: "string",
					description: "distDir with diagnostics/analyze (default .next)"
				},
				snapshot: {
					type: "string",
					description: "Named next analyze snapshot"
				},
				analyze: {
					type: "boolean",
					description: "Run `next analyze --output` first (use --no-analyze to reuse existing data)",
					default: true
				},
				vite: {
					type: "boolean",
					description: "Analyze a Vite app via an in-process build (auto-detected when vite is a dependency and next is not)"
				},
				"min-bytes": {
					type: "string",
					description: "Drop edges saving fewer bytes than this"
				},
				top: {
					type: "string",
					description: "Number of wins to print",
					default: "10"
				},
				json: {
					type: "boolean",
					description: "Print WinsReport JSON to stdout",
					default: false
				},
				compare: {
					type: "string",
					description: "Previous wins.json to compare against"
				},
				"budget-route": {
					type: "string",
					description: "Fail if any route first-load exceeds this many bytes"
				},
				"fail-on-safe-wins": {
					type: "string",
					description: "Fail if safe wins exceed this many bytes"
				}
			},
			async run({ args }) {
				const projectRoot = resolve(args.cwd);
				let report;
				try {
					const snapshot = args.snapshot ?? (args.analyze ? "wins" : void 0);
					const vite = args.vite ?? isViteProject(projectRoot);
					if (!vite && args.analyze && !args["analyze-export"]) await runNextAnalyze(projectRoot, snapshot);
					report = await runWins({
						projectRoot,
						analyzeExportPath: args["analyze-export"] ? resolve(projectRoot, args["analyze-export"]) : void 0,
						distDir: args["dist-dir"],
						snapshot,
						vite,
						minBytes: args["min-bytes"] ? Number(args["min-bytes"]) : void 0
					});
				} catch (err) {
					console.error(`wimb: ${err instanceof Error ? err.message : String(err)}`);
					process.exit(1);
				}
				const { jsonPath, mdPath } = writeWins(projectRoot, report);
				if (args.json) console.log(JSON.stringify(report, null, 2));
				else {
					console.log(formatWinsTerminal(report, { top: Number(args.top) || 10 }));
					console.log(`\nwimb: wrote ${jsonPath} and ${mdPath}`);
				}
				if (args.compare) {
					const cmp = compareWins(JSON.parse(readFileSync(resolve(projectRoot, args.compare), "utf-8")), report);
					console.error("wimb: first-load delta vs previous");
					for (const r of cmp.routes) console.error(`  ${r.route}  ${r.delta >= 0 ? "+" : ""}${(r.delta / 1024).toFixed(1)} KB`);
					console.error(`  wins resolved: ${cmp.resolved.length}, new: ${cmp.introduced.length}`);
				}
				const violations = checkBudget(report, {
					routeBudgetBytes: args["budget-route"] ? Number(args["budget-route"]) : void 0,
					maxSafeWinBytes: args["fail-on-safe-wins"] ? Number(args["fail-on-safe-wins"]) : void 0
				});
				for (const v of violations) console.error(`wimb: ${v.message}`);
				process.exit(violations.length ? 1 : 0);
			}
		})
	}
}));
//#endregion
export {};
