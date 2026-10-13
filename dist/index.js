#!/usr/bin/env node
import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import { dirname, extname, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { createOptions } from "knip/session";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
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
//#region src/data/server-packages.json
var server_packages_default = [
	"pg",
	"mysql2",
	"mongoose",
	"@prisma/client",
	"drizzle-orm",
	"ioredis",
	"nodemailer",
	"@aws-sdk/client-s3",
	"@aws-sdk/client-dynamodb",
	"stripe",
	"better-sqlite3",
	"knex",
	"typeorm"
];
//#endregion
//#region src/data/auth-crypto-packages.json
var auth_crypto_packages_default = [
	"jsonwebtoken",
	"bcrypt",
	"bcryptjs",
	"argon2",
	"jose",
	"crypto-js",
	"@node-rs/argon2"
];
//#endregion
//#region src/data/dev-packages.json
var dev_packages_default = [
	"@faker-js/faker",
	"faker",
	"why-did-you-render",
	"@redux-devtools/extension",
	"msw",
	"miragejs",
	"@storybook/react",
	"@testing-library/react"
];
//#endregion
//#region src/data/third-party-scripts.json
var third_party_scripts_default = [
	"react-ga4",
	"@segment/analytics-next",
	"hotjar",
	"@intercom/messenger-js-sdk",
	"mixpanel-browser",
	"posthog-js",
	"react-ga",
	"react-gtm-module"
];
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
const STATIC_RENDERERS = [
	"react-markdown",
	"marked",
	"remark",
	"highlight.js",
	"prismjs",
	"shiki",
	"katex"
];
const WASM_PACKAGES = [
	"@ffmpeg/ffmpeg",
	"sql.js",
	"tesseract.js",
	"@sqlite.org/sqlite-wasm"
];
const LOCALE_PATTERNS = [
	/moment\/locale$/,
	/moment-timezone$/,
	/date-fns\/locale$/,
	/cldr-data/,
	/intl-pluralrules/
];
function loadDataTables() {
	return {
		heavyPackages: new Set(heavy_packages_default),
		frameworkPackages: new Set(framework_packages_default),
		categoryMap: category_map_default,
		serverPackages: new Set(server_packages_default),
		authCryptoPackages: new Set(auth_crypto_packages_default),
		devPackages: new Set(dev_packages_default),
		thirdPartyScripts: new Set(third_party_scripts_default),
		onDemandLibs: new Set(on_demand_libs_default),
		heavyComponents: new Set(heavy_components_default),
		barrelPackages: new Set(barrel_packages_default),
		staticRenderers: new Set(STATIC_RENDERERS),
		wasmPackages: new Set(WASM_PACKAGES),
		localePatterns: LOCALE_PATTERNS.map((p) => new RegExp(p))
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
		rscPayloadMaxFields: 3,
		diffBudgetBytes: 0,
		diffFailOnNewFindings: true
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
const NEXT_BUILTIN_OPTIMIZE = [
	"lucide-react",
	"date-fns",
	"lodash-es",
	"@mui/material",
	"@mui/icons-material",
	"react-icons",
	"antd",
	"ramda"
];
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
const boundaryRules = [
	useClientUnnecessary,
	useClientTooHigh,
	{
		id: "use-client-mixed-components",
		category: "boundary",
		defaultSeverity: "warning",
		run(ctx) {
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (!mod.isBoundary) continue;
				if (isIgnored(ctx, "use-client-mixed-components", mod.filePath)) continue;
				const comps = mod.signals.components;
				if (comps.length < 2) continue;
				const withSignals = comps.filter((c) => c.signals > 0);
				const withoutSignals = comps.filter((c) => c.signals === 0);
				if (!withSignals.length || !withoutSignals.length) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:use-client-mixed-components`,
					ruleId: "use-client-mixed-components",
					category: "boundary",
					defaultSeverity: "warning",
					confidence: "high",
					file: mod.filePath,
					message: "Mixed server-safe and interactive components in one client boundary file",
					evidence: { components: comps.map((c) => ({
						name: c.name,
						signals: c.signals
					})) },
					fixStrategy: {
						name: "split-components",
						steps: [
							"Move signal-bearing components to a new file with 'use client'",
							"Remove 'use client' from the original file",
							"Update imports/re-exports"
						]
					}
				});
			}
		}
	},
	{
		id: "interactive-leaf-extractable",
		category: "boundary",
		defaultSeverity: "warning",
		run(ctx) {
			const { interactiveLeafRatio } = ctx.config.thresholds;
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (!mod.isBoundary) continue;
				if (mod.sourceBytes <= 8192) continue;
				if (isIgnored(ctx, "interactive-leaf-extractable", mod.filePath)) continue;
				const interactive = mod.signals.hooks.length + mod.signals.eventHandlers.length;
				if (!interactive) continue;
				if (interactive / Math.max(mod.sourceBytes / 100, 1) >= interactiveLeafRatio * 100) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:interactive-leaf-extractable`,
					ruleId: "interactive-leaf-extractable",
					category: "boundary",
					defaultSeverity: "warning",
					confidence: "low",
					file: mod.filePath,
					message: "Large client file with interactive code in a small region — extractable leaf",
					evidence: {
						sourceBytes: mod.sourceBytes,
						interactiveSignals: interactive
					},
					estimatedBytes: mod.sourceBytes,
					fixStrategy: {
						name: "extract-interactive-leaf",
						steps: ["Extract the interactive region into a new client component", "Remove 'use client' from the parent"]
					}
				});
			}
		}
	},
	{
		id: "provider-pulls-in-tree",
		category: "boundary",
		defaultSeverity: "error",
		run(ctx) {
			const { providerMinImports, providerMaxInstallSize } = ctx.config.thresholds;
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (!mod.isBoundary) continue;
				if (isIgnored(ctx, "provider-pulls-in-tree", mod.filePath)) continue;
				if (!mod.imports.some((i) => i.namedSymbols.some((s) => /Provider$/.test(s)) || /provider/i.test(i.specifier)) && mod.signals.jsxElements < 2) continue;
				const nonReactImports = mod.imports.filter((i) => i.packageName && i.packageName !== "react" && !isFrameworkPackage(ctx, i.packageName));
				const heavyImport = mod.imports.find((i) => i.packageName && !isFrameworkPackage(ctx, i.packageName) && getInstallSize(ctx, i.packageName) > providerMaxInstallSize);
				if (nonReactImports.length <= providerMinImports && !heavyImport) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:provider-pulls-in-tree`,
					ruleId: "provider-pulls-in-tree",
					category: "boundary",
					defaultSeverity: "error",
					confidence: "high",
					file: mod.filePath,
					message: "Provider boundary pulls in a large dependency tree",
					evidence: {
						imports: nonReactImports.map((i) => i.packageName),
						heavyImport: heavyImport?.packageName
					},
					estimatedBytes: mod.subtreeBytes,
					fixStrategy: {
						name: "minimal-provider",
						steps: ["Move provider into a minimal providers.tsx with only the provider + children", "Import everything else where it's used"]
					}
				});
			}
		}
	},
	{
		id: "mixed-module-split",
		category: "boundary",
		defaultSeverity: "error",
		run(ctx) {
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (mod.env !== "shared") continue;
				if (isIgnored(ctx, "mixed-module-split", mod.filePath)) continue;
				for (const exp of mod.exports) {
					if (!exp.referencedBy.every((r) => {
						const m = ctx.graph.modules.get(r.modulePath);
						return m && m.env === "server";
					}) || !exp.referencedBy.length) continue;
					if (!(mod.signals.nodeBuiltins.length > 0 || mod.signals.envReads.some((e) => !e.name.startsWith("NEXT_PUBLIC_")))) continue;
					reportFinding(ctx, {
						id: `${mod.filePath}:mixed-module-split:${exp.name}`,
						ruleId: "mixed-module-split",
						category: "boundary",
						defaultSeverity: "error",
						confidence: "medium",
						file: mod.filePath,
						message: `Export '${exp.name}' is server-only but module is shared with client`,
						evidence: {
							export: exp.name,
							referencedBy: exp.referencedBy
						},
						fixStrategy: {
							name: "split-server-module",
							steps: [
								`Split into ${exp.name}.server.ts with import 'server-only'`,
								"Keep client-safe remainder in the original file",
								"Update importers"
							]
						}
					});
				}
			}
		}
	},
	{
		id: "missing-poison-pill",
		category: "boundary",
		defaultSeverity: "info",
		run(ctx) {
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (isIgnored(ctx, "missing-poison-pill", mod.filePath)) continue;
				const hasServerSignals = mod.signals.nodeBuiltins.length > 0 || mod.imports.some((i) => i.packageName && ctx.data.serverPackages.has(i.packageName));
				if (!ctx.graph.clientModules.has(mod.filePath) && hasServerSignals && !mod.directives.has("server-only")) reportFinding(ctx, {
					id: `${mod.filePath}:missing-poison-pill:server`,
					ruleId: "missing-poison-pill",
					category: "boundary",
					defaultSeverity: "info",
					confidence: "high",
					file: mod.filePath,
					message: "Server-only module missing 'server-only' import",
					evidence: { nodeBuiltins: mod.signals.nodeBuiltins.length },
					fixStrategy: {
						name: "add-server-only",
						steps: ["Add import 'server-only' as the first import"]
					}
				});
				if (mod.signals.browserGlobals.length > 0 && mod.env === "server" && !mod.directives.has("client-only")) reportFinding(ctx, {
					id: `${mod.filePath}:missing-poison-pill:client`,
					ruleId: "missing-poison-pill",
					category: "boundary",
					defaultSeverity: "info",
					confidence: "high",
					file: mod.filePath,
					message: "Browser globals at top-level in server module — consider 'client-only'",
					evidence: {},
					fixStrategy: {
						name: "add-client-only",
						steps: ["Add import 'client-only' as the first import"]
					}
				});
			}
		}
	},
	{
		id: "app-barrel-reexport",
		category: "boundary",
		defaultSeverity: "warning",
		run(ctx) {
			const { barrelReexportRatio, barrelMinReexports } = ctx.config.thresholds;
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (isIgnored(ctx, "app-barrel-reexport", mod.filePath)) continue;
				const reexports = mod.imports.filter((i) => i.namedSymbols.includes("*") || i.specifier.startsWith("."));
				const totalStmts = mod.imports.length + mod.exports.length;
				if (totalStmts === 0) continue;
				if (reexports.length < barrelMinReexports) continue;
				if (reexports.length / totalStmts < barrelReexportRatio) continue;
				if (!mod.dependents.some((d) => ctx.graph.clientModules.has(d))) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:app-barrel-reexport`,
					ruleId: "app-barrel-reexport",
					category: "boundary",
					defaultSeverity: "warning",
					confidence: "high",
					file: mod.filePath,
					message: "Barrel file re-exports many modules and is imported by client code",
					evidence: { reexportCount: reexports.length },
					fixStrategy: {
						name: "direct-imports",
						steps: ["Change client importers to import from concrete source files", "Optionally delete the barrel"]
					}
				});
			}
		}
	},
	{
		id: "non-serializable-props",
		category: "boundary",
		defaultSeverity: "error",
		run(ctx) {
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (mod.env !== "server") continue;
				if (isIgnored(ctx, "non-serializable-props", mod.filePath)) continue;
				if (!mod.imports.some((i) => {
					if (!i.resolvedPath) return false;
					return ctx.graph.modules.get(i.resolvedPath)?.isBoundary;
				})) continue;
				const source = mod.ast().body;
				if (!JSON.stringify(source).match(/FunctionExpression|ArrowFunctionExpression|new Date|new Map|new Set|ClassDeclaration/)) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:non-serializable-props`,
					ruleId: "non-serializable-props",
					category: "boundary",
					defaultSeverity: "error",
					confidence: "medium",
					file: mod.filePath,
					message: "Server component may pass non-serializable props to a client component",
					evidence: { importChain: mod.importChainFromEntry },
					fixStrategy: {
						name: "serialize-props",
						steps: [
							"Move logic into the client component",
							"Pass serializable primitives only",
							"Or use a server action for callbacks"
						]
					}
				});
			}
		}
	},
	{
		id: "rsc-payload-bloat",
		category: "boundary",
		defaultSeverity: "warning",
		run(ctx) {
			const { rscPayloadMaxFields } = ctx.config.thresholds;
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (mod.env !== "server") continue;
				if (isIgnored(ctx, "rsc-payload-bloat", mod.filePath)) continue;
				if (!mod.imports.some((i) => {
					if (!i.resolvedPath) return false;
					return ctx.graph.modules.get(i.resolvedPath)?.isBoundary;
				})) continue;
				if (!mod.imports.some((i) => /fetch|db|prisma|drizzle/i.test(i.specifier)) && mod.signals.largestLiteralBytes < 5e3) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:rsc-payload-bloat`,
					ruleId: "rsc-payload-bloat",
					category: "boundary",
					defaultSeverity: "warning",
					confidence: "low",
					file: mod.filePath,
					message: "Server component may pass entire async result to client — pick fields server-side",
					evidence: { maxFields: rscPayloadMaxFields },
					fixStrategy: {
						name: "trim-payload",
						steps: ["Pick/map only the needed fields server-side before passing as props"]
					}
				});
			}
		}
	},
	{
		id: "metadata-in-client-file",
		category: "boundary",
		defaultSeverity: "error",
		run(ctx) {
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (!mod.isBoundary) continue;
				if (isIgnored(ctx, "metadata-in-client-file", mod.filePath)) continue;
				if (!mod.exports.some((e) => e.name === "metadata" || e.name === "generateMetadata")) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:metadata-in-client-file`,
					ruleId: "metadata-in-client-file",
					category: "boundary",
					defaultSeverity: "error",
					confidence: "high",
					file: mod.filePath,
					message: "metadata/generateMetadata exported from a client file",
					evidence: {},
					fixStrategy: {
						name: "move-metadata",
						steps: ["Move metadata to the nearest server layout/page", "Or split the file into server + client parts"]
					}
				});
			}
		}
	}
];
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
function loadNativeReplacements() {
	const result = /* @__PURE__ */ new Map();
	const path = manifestPath("native.json");
	if (!path) return result;
	try {
		const data = JSON.parse(readFileSync(path, "utf-8"));
		for (const [pkg, info] of Object.entries(data)) result.set(pkg, info.native ?? info.replacement ?? "native API");
	} catch {}
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
//#region src/rules/dependency/obsolete-polyfill.ts
const obsoletePolyfill = {
	id: "obsolete-polyfill",
	category: "dependency",
	defaultSeverity: "warning",
	run(ctx) {
		const natives = loadNativeReplacements();
		for (const [pkg, native] of natives) {
			const files = packageInClientGraph(ctx, pkg);
			if (!files.length) continue;
			if (isIgnored(ctx, "obsolete-polyfill", pkg)) continue;
			reportFinding(ctx, {
				id: `pkg:${pkg}:obsolete-polyfill`,
				ruleId: "obsolete-polyfill",
				category: "dependency",
				defaultSeverity: "warning",
				confidence: "high",
				file: files[0],
				message: `Obsolete polyfill '${pkg}' — use native ${native}`,
				evidence: {
					package: pkg,
					nativeApi: native,
					files
				},
				fixStrategy: {
					name: "remove-polyfill",
					steps: [`Delete dependency '${pkg}'`, `Use native API: ${native}`]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/dependency/duplicate-dependency-category.ts
const duplicateDependencyCategory = {
	id: "duplicate-dependency-category",
	category: "dependency",
	defaultSeverity: "warning",
	run(ctx) {
		for (const [category, packages] of Object.entries(ctx.data.categoryMap)) {
			const present = packages.filter((p) => packageInClientGraph(ctx, p).length > 0);
			if (present.length < 2) continue;
			if (isIgnored(ctx, "duplicate-dependency-category", category)) continue;
			reportFinding(ctx, {
				id: `category:${category}:duplicate-dependency-category`,
				ruleId: "duplicate-dependency-category",
				category: "dependency",
				defaultSeverity: "warning",
				confidence: "high",
				file: packageInClientGraph(ctx, present[0])[0],
				message: `Multiple ${category} libraries in client graph: ${present.join(", ")}`,
				evidence: {
					category,
					packages: present.map((p) => ({
						name: p,
						files: packageInClientGraph(ctx, p)
					}))
				},
				fixStrategy: {
					name: "consolidate-deps",
					steps: ["Consolidate on the package with more usages or the lighter one", "Migrate call sites"]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/dependency/duplicate-dependency-versions.ts
const duplicateDependencyVersions = {
	id: "duplicate-dependency-versions",
	category: "dependency",
	defaultSeverity: "warning",
	run(ctx) {
		for (const [pkg, versions] of ctx.pkg.lockfileVersions) {
			if (versions.length <= 1) continue;
			const files = packageInClientGraph(ctx, pkg);
			if (!files.length) continue;
			if (isIgnored(ctx, "duplicate-dependency-versions", pkg)) continue;
			reportFinding(ctx, {
				id: `pkg:${pkg}:duplicate-dependency-versions`,
				ruleId: "duplicate-dependency-versions",
				category: "dependency",
				defaultSeverity: "warning",
				confidence: "high",
				file: files[0],
				message: `Package '${pkg}' resolved to ${versions.length} versions in lockfile`,
				evidence: {
					package: pkg,
					versions,
					files
				},
				fixStrategy: {
					name: "dedupe-versions",
					steps: ["Add overrides/resolutions entry or bump dependencies", "Verify a single version resolves"]
				}
			});
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
//#region src/rules/dependency/dev-code-in-prod.ts
const TEST_PATTERNS = [
	/__mocks__\//,
	/\.test\./,
	/\.spec\./,
	/\.stories\./
];
const devCodeInProd = {
	id: "dev-code-in-prod",
	category: "dependency",
	defaultSeverity: "error",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				const isDevPkg = imp.packageName && ctx.data.devPackages.has(imp.packageName);
				const isTestPath = imp.resolvedPath && TEST_PATTERNS.some((p) => p.test(imp.resolvedPath));
				if (!isDevPkg && !isTestPath) continue;
				if (isIgnored(ctx, "dev-code-in-prod", path)) continue;
				reportFinding(ctx, {
					id: `${path}:dev-code-in-prod`,
					ruleId: "dev-code-in-prod",
					category: "dependency",
					defaultSeverity: "error",
					confidence: "medium",
					file: path,
					loc: imp.loc,
					message: "Dev/test code imported in client production graph",
					evidence: {
						specifier: imp.specifier,
						resolvedPath: imp.resolvedPath
					},
					fixStrategy: {
						name: "gate-dev-code",
						steps: ["Gate behind process.env.NODE_ENV check with dynamic import", "Or remove the import entirely"]
					}
				});
			}
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
//#region src/rules/dependency/static-icon-map.ts
const staticIconMap = {
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
};
//#endregion
//#region src/rules/dependency/node-builtin-polyfill-config.ts
const SHIM_PACKAGES = [
	"buffer",
	"process",
	"crypto-browserify",
	"stream-browserify",
	"events"
];
//#endregion
//#region src/rules/dependency/index.ts
const dependencyRules = [
	replaceableDependency,
	heavyClientImport,
	barrelImport,
	obsoletePolyfill,
	duplicateDependencyCategory,
	duplicateDependencyVersions,
	runtimeCssInJs,
	devCodeInProd,
	transitiveHeavyDependency,
	staticIconMap,
	{
		id: "node-builtin-polyfill-config",
		category: "dependency",
		defaultSeverity: "warning",
		run(ctx) {
			if (ctx.nextConfig?.webpackFallbacks.length) reportFinding(ctx, {
				id: "next-config:webpack-fallback",
				ruleId: "node-builtin-polyfill-config",
				category: "dependency",
				defaultSeverity: "warning",
				confidence: "high",
				file: "next.config",
				message: "next.config webpack resolve.fallback shims Node built-ins for the browser",
				evidence: { fallbacks: ctx.nextConfig.webpackFallbacks },
				fixStrategy: {
					name: "remove-shims",
					steps: ["Find the client module needing the shim", "Move server logic server-side instead of shimming"]
				}
			});
			for (const pkg of SHIM_PACKAGES) {
				if (!ctx.pkg.dependencies[pkg]) continue;
				if (isIgnored(ctx, "node-builtin-polyfill-config", pkg)) continue;
				reportFinding(ctx, {
					id: `pkg:${pkg}:node-builtin-polyfill-config`,
					ruleId: "node-builtin-polyfill-config",
					category: "dependency",
					defaultSeverity: "warning",
					confidence: "high",
					file: "package.json",
					message: `Browser shim package '${pkg}' in dependencies`,
					evidence: { package: pkg },
					fixStrategy: {
						name: "remove-shim-dep",
						steps: [
							"Find client module needing the shim",
							"Move that code server-side",
							"Remove shim dependency"
						]
					}
				});
			}
		}
	}
];
//#endregion
//#region src/rules/misplacement/server-logic-in-client.ts
const serverLogicInClient = {
	id: "server-logic-in-client",
	category: "misplacement",
	defaultSeverity: "error",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			if (isIgnored(ctx, "server-logic-in-client", path)) continue;
			const serverImports = mod.imports.filter((i) => i.packageName && ctx.data.serverPackages.has(i.packageName));
			const secretEnv = mod.signals.envReads.filter((e) => !e.name.startsWith("NEXT_PUBLIC_"));
			if (!mod.signals.nodeBuiltins.length && !serverImports.length && !secretEnv.length) continue;
			reportFinding(ctx, {
				id: `${path}:server-logic-in-client`,
				ruleId: "server-logic-in-client",
				category: "misplacement",
				defaultSeverity: "error",
				confidence: "high",
				file: path,
				message: "Server logic detected in client graph",
				evidence: {
					nodeBuiltins: mod.signals.nodeBuiltins,
					serverImports: serverImports.map((i) => i.packageName),
					envReads: secretEnv.map((e) => e.name),
					importChain: mod.importChainFromEntry
				},
				fixStrategy: {
					name: "move-server-logic",
					steps: [
						"Data read at render time → Server Component fetch",
						"Mutation → server action",
						"Client-triggered read → route handler",
						"Move the import behind that boundary"
					]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/misplacement/auth-crypto-in-client.ts
const authCryptoInClient = {
	id: "auth-crypto-in-client",
	category: "misplacement",
	defaultSeverity: "error",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			if (isIgnored(ctx, "auth-crypto-in-client", path)) continue;
			const authImports = mod.imports.filter((i) => i.packageName && ctx.data.authCryptoPackages.has(i.packageName));
			const schemaImport = mod.imports.some((i) => /prisma\/schema|db\/schema|\/models\//.test(i.resolvedPath ?? i.specifier));
			if (!authImports.length && !schemaImport) continue;
			reportFinding(ctx, {
				id: `${path}:auth-crypto-in-client`,
				ruleId: "auth-crypto-in-client",
				category: "misplacement",
				defaultSeverity: "error",
				confidence: "high",
				file: path,
				message: "SECURITY: Auth/crypto code in client graph",
				evidence: {
					imports: authImports.map((i) => i.packageName),
					schemaImport,
					importChain: mod.importChainFromEntry
				},
				fixStrategy: {
					name: "move-auth-server",
					steps: [
						"Move all auth/crypto operations server-side immediately",
						"Rotate any exposed credentials",
						"Use server actions or route handlers for auth flows"
					]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/misplacement/env-var-misuse.ts
const SECRET_PATTERN = /(secret|private|service[_-]?role|api[_-]?key|token|password)/i;
const PUBLIC_ALLOW = /_PUBLISHABLE_KEY$|_SITE_KEY$/;
//#endregion
//#region src/rules/misplacement/index.ts
const misplacementRules = [
	serverLogicInClient,
	authCryptoInClient,
	{
		id: "env-var-misuse",
		category: "misplacement",
		defaultSeverity: "error",
		run(ctx) {
			for (const path of projectClientModulePaths(ctx)) {
				const mod = ctx.graph.modules.get(path);
				if (isIgnored(ctx, "env-var-misuse", path)) continue;
				for (const env of mod.signals.envReads) if (env.name.startsWith("NEXT_PUBLIC_")) {
					if (SECRET_PATTERN.test(env.name) && !PUBLIC_ALLOW.test(env.name)) reportFinding(ctx, {
						id: `${path}:env-var-misuse:public-secret`,
						ruleId: "env-var-misuse",
						category: "misplacement",
						defaultSeverity: "error",
						confidence: "high",
						file: path,
						loc: env.loc,
						message: `NEXT_PUBLIC env var '${env.name}' looks like a secret`,
						evidence: { envVar: env.name },
						fixStrategy: {
							name: "rotate-secret",
							steps: ["Move secret usage server-side", "Rotate the credential immediately"]
						}
					});
				} else reportFinding(ctx, {
					id: `${path}:env-var-misuse:non-public`,
					ruleId: "env-var-misuse",
					category: "misplacement",
					defaultSeverity: "error",
					confidence: "high",
					file: path,
					loc: env.loc,
					message: `Non-NEXT_PUBLIC env read '${env.name}' in client — undefined at runtime`,
					evidence: { envVar: env.name },
					fixStrategy: {
						name: "fix-env-access",
						steps: ["Rename to NEXT_PUBLIC_ only if genuinely public", "Otherwise restructure to read server-side"]
					}
				});
			}
		}
	},
	{
		id: "third-party-script-as-import",
		category: "misplacement",
		defaultSeverity: "warning",
		run(ctx) {
			for (const path of projectClientModulePaths(ctx)) {
				const mod = ctx.graph.modules.get(path);
				for (const imp of mod.imports) {
					if (!imp.packageName || !ctx.data.thirdPartyScripts.has(imp.packageName)) continue;
					if (isIgnored(ctx, "third-party-script-as-import", path)) continue;
					reportFinding(ctx, {
						id: `${path}:third-party-script-as-import`,
						ruleId: "third-party-script-as-import",
						category: "misplacement",
						defaultSeverity: "warning",
						confidence: "high",
						file: path,
						loc: imp.loc,
						message: `Analytics/tracking '${imp.packageName}' statically imported — use next/script`,
						evidence: { package: imp.packageName },
						fixStrategy: {
							name: "lazy-script",
							steps: ["Use @next/third-parties where supported", "Otherwise next/script with strategy='lazyOnload' or 'afterInteractive'"]
						}
					});
				}
			}
		}
	},
	{
		id: "static-content-rendered-client",
		category: "misplacement",
		defaultSeverity: "warning",
		run(ctx) {
			for (const path of projectClientModulePaths(ctx)) {
				const mod = ctx.graph.modules.get(path);
				if (!mod.isBoundary) continue;
				const renderer = mod.imports.find((i) => i.packageName && ctx.data.staticRenderers.has(i.packageName));
				if (!renderer) continue;
				if (mod.signals.hooks.some((h) => h.line > 0) && mod.signals.eventHandlers.length > 2) continue;
				if (isIgnored(ctx, "static-content-rendered-client", path)) continue;
				reportFinding(ctx, {
					id: `${path}:static-content-rendered-client`,
					ruleId: "static-content-rendered-client",
					category: "misplacement",
					defaultSeverity: "warning",
					confidence: "medium",
					file: path,
					loc: renderer.loc,
					message: `Static content rendered client-side via '${renderer.packageName}'`,
					evidence: { renderer: renderer.packageName },
					fixStrategy: {
						name: "server-render-content",
						steps: [
							"Render in a Server Component or precompute at build",
							"Ship HTML to client",
							"Keep client renderer only for live-editing use cases"
						]
					}
				});
			}
		}
	},
	{
		id: "use-server-file-mixed-exports",
		category: "misplacement",
		defaultSeverity: "warning",
		run(ctx) {
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (!mod.directives.has("use server")) continue;
				if (isIgnored(ctx, "use-server-file-mixed-exports", mod.filePath)) continue;
				const nonAsync = mod.exports.filter((e) => !e.isAsync && e.name !== "default");
				if (!nonAsync.length) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:use-server-file-mixed-exports`,
					ruleId: "use-server-file-mixed-exports",
					category: "misplacement",
					defaultSeverity: "warning",
					confidence: "high",
					file: mod.filePath,
					message: "'use server' file exports non-async functions — every export is a public endpoint",
					evidence: { exports: nonAsync.map((e) => e.name) },
					fixStrategy: {
						name: "isolate-actions",
						steps: ["Keep only server actions in 'use server' files", "Move helpers to a plain module with import 'server-only'"]
					}
				});
			}
		}
	},
	{
		id: "middleware-heavy-imports",
		category: "misplacement",
		defaultSeverity: "error",
		run(ctx) {
			const { middlewareSourceBytes, middlewarePackageBytes } = ctx.config.thresholds;
			for (const mod of ctx.graph.modules.values()) {
				if (!isProjectSource(ctx, mod.filePath)) continue;
				if (!/middleware\.(t|j)s$/.test(mod.filePath)) continue;
				if (isIgnored(ctx, "middleware-heavy-imports", mod.filePath)) continue;
				let closureBytes = mod.sourceBytes;
				const heavyPkgs = [];
				for (const imp of mod.imports) {
					if (imp.resolvedPath) {
						const dep = ctx.graph.modules.get(imp.resolvedPath);
						if (dep) closureBytes += dep.sourceBytes;
					}
					if (imp.packageName && !isFrameworkPackage(ctx, imp.packageName)) {
						if (getInstallSize(ctx, imp.packageName) > middlewarePackageBytes) heavyPkgs.push(imp.packageName);
					}
				}
				if (closureBytes <= middlewareSourceBytes && !heavyPkgs.length) continue;
				reportFinding(ctx, {
					id: `${mod.filePath}:middleware-heavy-imports`,
					ruleId: "middleware-heavy-imports",
					category: "misplacement",
					defaultSeverity: "error",
					confidence: "high",
					file: mod.filePath,
					message: "Middleware import closure is too heavy for edge runtime",
					evidence: {
						closureBytes,
						heavyPackages: heavyPkgs
					},
					estimatedBytes: closureBytes,
					fixStrategy: {
						name: "trim-middleware",
						steps: [
							"Trim middleware to edge-safe primitives",
							"Move heavy work into route handlers or layouts",
							"Note Next edge bundle size limits"
						]
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
//#region src/rules/loading/locale-data-bloat.ts
const localeDataBloat = {
	id: "locale-data-bloat",
	category: "loading",
	defaultSeverity: "error",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				if (!ctx.data.localePatterns.some((p) => p.test(imp.specifier))) continue;
				if (isIgnored(ctx, "locale-data-bloat", path)) continue;
				reportFinding(ctx, {
					id: `${path}:locale-data-bloat`,
					ruleId: "locale-data-bloat",
					category: "loading",
					defaultSeverity: "error",
					confidence: "high",
					file: path,
					loc: imp.loc,
					message: `Locale/timezone data bloat: '${imp.specifier}'`,
					evidence: { specifier: imp.specifier },
					fixStrategy: {
						name: "lazy-locales",
						steps: [
							"Import only needed locales",
							"Load locale catalogs with dynamic import() keyed by active locale",
							"For timezones use Intl.DateTimeFormat or moment-timezone/builds subsets"
						]
					}
				});
			}
		}
	}
};
//#endregion
//#region src/rules/loading/syntax-highlighter-all-languages.ts
const syntaxHighlighterAllLanguages = {
	id: "syntax-highlighter-all-languages",
	category: "loading",
	defaultSeverity: "warning",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				const isFullHljs = imp.specifier === "highlight.js" || imp.specifier === "prismjs";
				const isShikiBundle = /shiki/.test(imp.specifier) && !imp.specifier.includes("/");
				if (!isFullHljs && !isShikiBundle) continue;
				if (isIgnored(ctx, "syntax-highlighter-all-languages", path)) continue;
				reportFinding(ctx, {
					id: `${path}:syntax-highlighter-all-languages`,
					ruleId: "syntax-highlighter-all-languages",
					category: "loading",
					defaultSeverity: "warning",
					confidence: "high",
					file: path,
					loc: imp.loc,
					message: "Syntax highlighter imports all languages — use core + registerLanguage",
					evidence: { specifier: imp.specifier },
					fixStrategy: {
						name: "subset-highlighter",
						steps: ["Use highlight.js/lib/core + explicit registerLanguage", "Or move highlighting server-side"]
					}
				});
			}
		}
	}
};
//#endregion
//#region src/rules/loading/client-search-index.ts
const SEARCH_LIBS = [
	"lunr",
	"flexsearch",
	"fuse.js",
	"minisearch"
];
const clientSearchIndex = {
	id: "client-search-index",
	category: "loading",
	defaultSeverity: "warning",
	run(ctx) {
		const { searchIndexMinBytes } = ctx.config.thresholds;
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			if (!mod.imports.some((i) => i.packageName && SEARCH_LIBS.includes(i.packageName))) continue;
			if (!mod.imports.some((i) => i.resolvedPath?.endsWith(".json") && (ctx.graph.modules.get(i.resolvedPath)?.sourceBytes ?? 0) > searchIndexMinBytes) && mod.signals.largestLiteralBytes <= searchIndexMinBytes) continue;
			if (isIgnored(ctx, "client-search-index", path)) continue;
			reportFinding(ctx, {
				id: `${path}:client-search-index`,
				ruleId: "client-search-index",
				category: "loading",
				defaultSeverity: "warning",
				confidence: "medium",
				file: path,
				message: "Client search index with large static data",
				evidence: {},
				fixStrategy: {
					name: "lazy-search",
					steps: ["Lazy-load the index on first search interaction", "Or move search to a route handler"]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/loading/large-static-data-in-client.ts
const largeStaticDataInClient = {
	id: "large-static-data-in-client",
	category: "loading",
	defaultSeverity: "warning",
	run(ctx) {
		const { largeJsonBytes, largeLiteralBytes } = ctx.config.thresholds;
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			const jsonImport = mod.imports.find((i) => i.resolvedPath?.endsWith(".json") && (ctx.graph.modules.get(i.resolvedPath)?.sourceBytes ?? 0) > largeJsonBytes);
			const largeLiteral = mod.signals.largestLiteralBytes > largeLiteralBytes;
			if (!jsonImport && !largeLiteral) continue;
			if (isIgnored(ctx, "large-static-data-in-client", path)) continue;
			reportFinding(ctx, {
				id: `${path}:large-static-data-in-client`,
				ruleId: "large-static-data-in-client",
				category: "loading",
				defaultSeverity: "warning",
				confidence: "high",
				file: path,
				message: "Large static data shipped in client module",
				evidence: {
					jsonImport: jsonImport?.resolvedPath,
					largestLiteralBytes: mod.signals.largestLiteralBytes
				},
				estimatedBytes: mod.signals.largestLiteralBytes,
				fixStrategy: {
					name: "move-data-server",
					steps: ["Move data server-side and pass needed slice as props", "Fetch on demand or import() lazily"]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/loading/inline-svg-collection.ts
const inlineSvgCollection = {
	id: "inline-svg-collection",
	category: "loading",
	defaultSeverity: "info",
	run(ctx) {
		const { inlineSvgMinCount, inlineSvgMinBytes } = ctx.config.thresholds;
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			if (mod.signals.jsxElements < inlineSvgMinCount) continue;
			if (mod.sourceBytes < inlineSvgMinBytes) continue;
			if (isIgnored(ctx, "inline-svg-collection", path)) continue;
			reportFinding(ctx, {
				id: `${path}:inline-svg-collection`,
				ruleId: "inline-svg-collection",
				category: "loading",
				defaultSeverity: "info",
				confidence: "medium",
				file: path,
				message: "Many inline SVG elements increase client bundle size",
				evidence: {
					jsxElements: mod.signals.jsxElements,
					sourceBytes: mod.sourceBytes
				},
				estimatedBytes: mod.sourceBytes,
				fixStrategy: {
					name: "optimize-svgs",
					steps: [
						"Use SVG sprite sheet",
						"Use next/image for static art",
						"Or render SVGs server-side"
					]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/loading/asset-in-bundle.ts
const ASSET_EXTS = /\.(png|jpe?g|gif|mp4|woff2?)$/i;
const assetInBundle = {
	id: "asset-in-bundle",
	category: "loading",
	defaultSeverity: "warning",
	run(ctx) {
		const { base64MinBytes } = ctx.config.thresholds;
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				if (!ASSET_EXTS.test(imp.specifier) && !/@fontsource/.test(imp.specifier)) continue;
				if (isIgnored(ctx, "asset-in-bundle", path)) continue;
				reportFinding(ctx, {
					id: `${path}:asset-in-bundle`,
					ruleId: "asset-in-bundle",
					category: "loading",
					defaultSeverity: "warning",
					confidence: "high",
					file: path,
					loc: imp.loc,
					message: `Binary asset '${imp.specifier}' imported into client bundle`,
					evidence: { specifier: imp.specifier },
					fixStrategy: {
						name: "public-assets",
						steps: ["Move to public/ and use next/image for media", "Use next/font for fonts"]
					}
				});
			}
			if (mod.signals.largestLiteralBytes > base64MinBytes) reportFinding(ctx, {
				id: `${path}:asset-in-bundle:base64`,
				ruleId: "asset-in-bundle",
				category: "loading",
				defaultSeverity: "warning",
				confidence: "medium",
				file: path,
				message: "Large base64 data URI detected in client source",
				evidence: { bytes: mod.signals.largestLiteralBytes },
				estimatedBytes: mod.signals.largestLiteralBytes,
				fixStrategy: {
					name: "external-asset",
					steps: ["Move asset to public/ or use next/image"]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/loading/wasm-eager-load.ts
const wasmEagerLoad = {
	id: "wasm-eager-load",
	category: "loading",
	defaultSeverity: "warning",
	run(ctx) {
		for (const path of projectClientModulePaths(ctx)) {
			const mod = ctx.graph.modules.get(path);
			for (const imp of mod.imports) {
				if (!(imp.specifier.endsWith(".wasm") || imp.packageName && ctx.data.wasmPackages.has(imp.packageName)) || imp.isDynamic) continue;
				if (isIgnored(ctx, "wasm-eager-load", path)) continue;
				reportFinding(ctx, {
					id: `${path}:wasm-eager-load`,
					ruleId: "wasm-eager-load",
					category: "loading",
					defaultSeverity: "warning",
					confidence: "high",
					file: path,
					loc: imp.loc,
					message: `WASM '${imp.specifier}' eagerly loaded in client initial bundle`,
					evidence: { specifier: imp.specifier },
					fixStrategy: {
						name: "lazy-wasm",
						steps: ["Use dynamic import() on first use", "Trigger inside the user interaction that needs WASM"]
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
	localeDataBloat,
	syntaxHighlighterAllLanguages,
	clientSearchIndex,
	largeStaticDataInClient,
	inlineSvgCollection,
	assetInBundle,
	wasmEagerLoad,
	nextDynamicMisuse
];
//#endregion
//#region src/rules/config/missing-optimize-package-imports.ts
const missingOptimizePackageImports = {
	id: "missing-optimize-package-imports",
	category: "config",
	defaultSeverity: "warning",
	run(ctx) {
		const configured = new Set([...NEXT_BUILTIN_OPTIMIZE, ...ctx.nextConfig?.optimizePackageImports ?? []]);
		for (const pkg of ctx.data.barrelPackages) {
			if (configured.has(pkg)) continue;
			if (!packageInClientGraph(ctx, pkg).length) continue;
			if (isIgnored(ctx, "missing-optimize-package-imports", pkg)) continue;
			reportFinding(ctx, {
				id: `config:missing-optimize-package-imports:${pkg}`,
				ruleId: "missing-optimize-package-imports",
				category: "config",
				defaultSeverity: "warning",
				confidence: "high",
				file: "next.config",
				message: `Add '${pkg}' to experimental.optimizePackageImports`,
				evidence: {
					package: pkg,
					files: packageInClientGraph(ctx, pkg)
				},
				fixStrategy: {
					name: "optimize-imports",
					steps: [`Add '${pkg}' to experimental.optimizePackageImports in next.config`]
				}
			});
		}
	}
};
//#endregion
//#region src/rules/config/legacy-browser-targets.ts
const LEGACY_PATTERNS = /\bie\b|op_mini|last\s+2\s+versions|>?\s*0\.?\d+%/i;
//#endregion
//#region src/rules/config/index.ts
const configRules = [
	missingOptimizePackageImports,
	{
		id: "legacy-browser-targets",
		category: "config",
		defaultSeverity: "warning",
		run(ctx) {
			const pkgPath = join(ctx.projectRoot, "package.json");
			const browserslistRc = join(ctx.projectRoot, ".browserslistrc");
			let query = "";
			if (existsSync(browserslistRc)) query = readFileSync(browserslistRc, "utf-8");
			else {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				query = typeof pkg.browserslist === "string" ? pkg.browserslist : JSON.stringify(pkg.browserslist ?? "");
			}
			if (!query || !LEGACY_PATTERNS.test(query)) return;
			if (isIgnored(ctx, "legacy-browser-targets", "browserslist")) return;
			reportFinding(ctx, {
				id: "config:legacy-browser-targets",
				ruleId: "legacy-browser-targets",
				category: "config",
				defaultSeverity: "warning",
				confidence: "high",
				file: existsSync(browserslistRc) ? ".browserslistrc" : "package.json",
				message: "Legacy browserslist targets inflate transpilation and polyfills",
				evidence: { query },
				fixStrategy: {
					name: "modern-targets",
					steps: ["Adopt modern targets (e.g. 'defaults and fully supports es6-module')", "Note Next's own default targets"]
				}
			});
		}
	},
	{
		id: "route-over-budget",
		category: "config",
		defaultSeverity: "error",
		run(ctx) {
			if (!ctx.byteAttribution) return;
			const { routeBudgetBytes } = ctx.config.thresholds;
			for (const [route, bytes] of ctx.byteAttribution.routes) {
				if (bytes <= routeBudgetBytes) continue;
				if (isIgnored(ctx, "route-over-budget", route)) continue;
				reportFinding(ctx, {
					id: `route:${route}:route-over-budget`,
					ruleId: "route-over-budget",
					category: "config",
					defaultSeverity: "error",
					confidence: "high",
					file: route,
					message: `Route '${route}' exceeds client byte budget (${bytes} > ${routeBudgetBytes})`,
					evidence: {
						route,
						bytes,
						budget: routeBudgetBytes
					},
					estimatedBytes: bytes,
					fixStrategy: {
						name: "reduce-route-bytes",
						steps: ["Review findings for this route sorted by estimatedBytes", "Address highest-confidence findings first"]
					}
				});
			}
		}
	}
];
//#endregion
//#region src/rules/index.ts
function getAllRules() {
	return [
		...boundaryRules,
		...dependencyRules,
		...misplacementRules,
		...loadingRules,
		...configRules
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
			ingestPart(record, routeTotals, perRouteModules);
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
function ingestPart(part, routeTotals, perRouteModules) {
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
		const attribution = attributeRoute(header, binary);
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
function attributeRoute(header, binary) {
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
		`**Mode:** ${report.mode} | **Findings:** ${report.summary.total} | **${report.summary.byteSource === "measured" ? "Measured" : "Est."} client bytes:** ${formatBytes$2(report.summary.estimatedClientBytes)}`,
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
		lines.push(`**${label}:** ${formatBytes$2(f.estimatedBytes)}`);
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
function formatBytes$2(n) {
	if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}
//#endregion
//#region src/report/sarif.ts
function toSarif(report) {
	return {
		$schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
		version: "2.1.0",
		runs: [{
			tool: { driver: {
				name: "wimb",
				version: report.version,
				informationUri: "https://github.com/where-is-my-banana",
				rules: [...new Set(report.findings.map((f) => f.ruleId))].map((id) => ({
					id,
					shortDescription: { text: id }
				}))
			} },
			results: report.findings.map((f) => ({
				ruleId: f.ruleId,
				level: f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "note",
				message: { text: f.message },
				locations: [{ physicalLocation: {
					artifactLocation: { uri: f.file },
					region: f.loc ? {
						startLine: f.loc.line,
						startColumn: f.loc.column
					} : void 0
				} }],
				properties: {
					confidence: f.confidence,
					estimatedBytes: f.estimatedBytes,
					fixStrategy: f.fixStrategy,
					evidence: f.evidence
				}
			}))
		}]
	};
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
	if (formats.has("sarif")) writeFileSync(join(outputDir, "wimb-report.sarif"), JSON.stringify(toSarif(report), null, 2));
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
		const bytes = f.estimatedBytes != null && f.estimatedBytes > 0 ? ` (${formatBytes$1(f.estimatedBytes)})` : "";
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
function formatBytes$1(n) {
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
//#region src/external/e18e.ts
const SEVERITY_MAP$1 = {
	error: "error",
	warn: "warning",
	warning: "warning",
	info: "info"
};
/**
* Run @e18e/cli analyze. Resolves the binary from the target app or wimb's
* optional dependency before falling back to `npx`.
*/
async function runE18eAnalysis(projectRoot) {
	try {
		const stdout = runE18eCli(projectRoot);
		return (JSON.parse(stdout).messages ?? []).map((msg, index) => toFinding$1(msg, index));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`wimb: e18e analysis skipped (${message})`);
		return [];
	}
}
function runE18eCli(projectRoot) {
	const bin = resolveE18eBin(projectRoot);
	if (bin) return execFileSync(bin, ["analyze", "--json"], {
		cwd: projectRoot,
		encoding: "utf-8",
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		]
	});
	return execFileSync("npx", [
		"--yes",
		"@e18e/cli",
		"analyze",
		"--json"
	], {
		cwd: projectRoot,
		encoding: "utf-8",
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		]
	});
}
function resolveE18eBin(projectRoot) {
	const candidates = [join(projectRoot, "node_modules", ".bin", "e18e"), join(projectRoot, "node_modules", "@e18e", "cli", "bin", "e18e.js")];
	for (const path of candidates) if (existsSync(path)) return path;
	try {
		const require = createRequire(import.meta.url);
		const dir = join(require.resolve("@e18e/cli/package.json"), "..");
		for (const rel of [
			"bin/e18e.js",
			"dist/cli.js",
			"bin/cli.js"
		]) {
			const candidate = join(dir, rel);
			if (existsSync(candidate)) return candidate;
		}
		const pkg = require("@e18e/cli/package.json");
		if (typeof pkg.bin === "string") {
			const candidate = join(dir, pkg.bin);
			if (existsSync(candidate)) return candidate;
		} else if (pkg.bin && typeof pkg.bin === "object") for (const rel of Object.values(pkg.bin)) {
			const candidate = join(dir, rel);
			if (existsSync(candidate)) return candidate;
		}
	} catch {}
	return null;
}
function toFinding$1(msg, index) {
	const category = msg.category ?? "dependency";
	const ruleId = msg.ruleId ? `e18e:${msg.ruleId}` : `e18e:${category}`;
	const severity = SEVERITY_MAP$1[msg.severity ?? "info"] ?? "info";
	return {
		id: `e18e:${index}:${ruleId}`,
		ruleId,
		category,
		severity,
		confidence: "high",
		file: msg.filePath ?? "package.json",
		loc: msg.line ? {
			line: msg.line,
			column: msg.column ?? 1
		} : void 0,
		message: msg.message ?? "e18e diagnostic",
		evidence: { e18e: msg },
		fixStrategy: {
			name: msg.fixable ? "e18e-fixable" : "e18e-review",
			steps: msg.fixable ? ["Run npx @e18e/cli migrate for automated fixes where available"] : ["Review e18e diagnostic and apply suggested remediation"]
		},
		source: "e18e"
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
//#region src/external/rsc-xray.ts
/**
* Diagnostics WIMB already covers — skip to avoid duplicate findings.
*/
const SKIP_DIAGNOSTIC_IDS = new Set([
	"client-forbidden-import",
	"use-client-unnecessary",
	"oversized-client-component",
	"client-component-oversized"
]);
const SEVERITY_MAP = {
	error: "error",
	warn: "warning",
	warning: "warning",
	info: "info",
	hint: "info"
};
/**
* Opt-in integration with @rsc-xray/analyzer.
* Maps unique RSC diagnostics (serialization, duplicates, suspense) to findings.
*/
async function runRscXrayAnalysis(projectRoot, config) {
	try {
		const model = await invokeAnalyzer(projectRoot);
		if (!model) return [];
		return (model.diagnostics ?? model.findings ?? model.issues ?? []).map((d, i) => toFinding(d, i, config)).filter((f) => f != null);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`wimb: rsc-xray analysis skipped (${message})`);
		return [];
	}
}
async function invokeAnalyzer(projectRoot) {
	const candidates = [projectRoot, join(projectRoot, "..")];
	for (const base of candidates) try {
		const mod = await import(pathToFileURL(createRequire(join(base, "package.json")).resolve("@rsc-xray/analyzer")).href);
		const analyze = mod.analyze ?? mod.default?.analyze;
		if (typeof analyze === "function") return await analyze({
			projectRoot,
			cwd: projectRoot
		});
	} catch {}
	let importError;
	try {
		const mod = await import("@rsc-xray/analyzer");
		const analyze = mod.analyze ?? mod.default?.analyze;
		if (typeof analyze === "function") return await analyze({ projectRoot });
	} catch (err) {
		importError = err;
	}
	if (importError) throw importError;
	console.error("wimb: @rsc-xray/analyzer not found. Install it in the target app or as a peer dependency.");
	return null;
}
function toFinding(diag, index, config) {
	const rawId = diag.ruleId ?? diag.id ?? diag.code ?? "unknown";
	if (SKIP_DIAGNOSTIC_IDS.has(rawId)) return null;
	const ruleId = rawId.startsWith("rsc-xray:") ? rawId : `rsc-xray:${rawId}`;
	const severity = config.severityOverrides[ruleId] ?? SEVERITY_MAP[diag.severity ?? "info"] ?? "info";
	const file = diag.filePath ?? diag.file ?? "unknown";
	return {
		id: `rsc-xray:${index}:${ruleId}:${file}`,
		ruleId,
		category: diag.category ?? mapCategory(rawId),
		severity,
		confidence: "high",
		file,
		loc: diag.line ? {
			line: diag.line,
			column: diag.column ?? 1
		} : void 0,
		message: diag.message ?? `rsc-xray: ${rawId}`,
		evidence: { "rsc-xray": diag },
		fixStrategy: {
			name: "rsc-xray-review",
			steps: ["Review the rsc-xray diagnostic and apply the suggested remediation", "See https://github.com/rsc-xray/rsc-xray for codemods when available"]
		},
		source: "rsc-xray"
	};
}
function mapCategory(id) {
	if (id.includes("serial") || id.includes("forbidden") || id.includes("server-only")) return "misplacement";
	if (id.includes("suspense") || id.includes("waterfall") || id.includes("duplicate")) return "loading";
	if (id.includes("boundary") || id.includes("client")) return "boundary";
	return "dependency";
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
	if (opts.e18e) for (const finding of await runE18eAnalysis(projectRoot)) {
		if (shouldIgnore(finding.ruleId)) continue;
		findings.push(finding);
	}
	if (opts.rscXray) for (const finding of await runRscXrayAnalysis(projectRoot, config)) {
		if (shouldIgnore(finding.ruleId)) continue;
		findings.push(finding);
	}
	const report = buildReport(projectRoot, opts.build || byteAttribution?.measured ? "build" : "source", findings, { byteSource: byteAttribution?.measured ? "measured" : "estimated" });
	writeReports(projectRoot, report, new Set(opts.formats ?? ["json", "md"]));
	if (opts.baseline) {
		const { compareReports, writeDiffReport, exitCodeForDiff } = await Promise.resolve().then(() => diff_exports);
		const diff = compareReports(opts.baseline, report, config);
		writeDiffReport(projectRoot, diff);
		console.log(`wimb: diff vs baseline — Δbytes ${diff.byteDelta}, +${diff.newFindings.length}/-${diff.resolvedFindings.length} findings`);
		if (exitCodeForDiff(diff, config) !== 0) {
			printFindingsToTerminal(report);
			console.log(`wimb: ${report.summary.total} findings, budget exceeded → ${resolveOutputDir(projectRoot)}`);
			return 1;
		}
	}
	console.log("wimb: writing forest.json...");
	const forest = writeForestReport(projectRoot, graph, byteAttribution, {
		compact: opts.forestCompact,
		heavySubtreeThreshold: config.thresholds.dynamicImportMinSubtree,
		verbose: true
	});
	printFindingsToTerminal(report);
	console.log(`wimb: ${report.summary.total} findings (${report.summary.bySeverity.error} errors, ${report.summary.bySeverity.warning} warnings), ${forest.pages.length} pages → ${resolveOutputDir(projectRoot)}`);
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
//#region src/diff.ts
var diff_exports = /* @__PURE__ */ __exportAll({
	compareReports: () => compareReports,
	exitCodeForDiff: () => exitCodeForDiff,
	loadReport: () => loadReport,
	toDiffMarkdown: () => toDiffMarkdown,
	writeDiffReport: () => writeDiffReport
});
function loadReport(path) {
	const abs = resolve(path);
	if (!existsSync(abs)) throw new Error(`baseline report not found: ${abs}`);
	return JSON.parse(readFileSync(abs, "utf-8"));
}
function compareReports(baselinePathOrReport, current, config) {
	const baseline = typeof baselinePathOrReport === "string" ? loadReport(baselinePathOrReport) : baselinePathOrReport;
	const baselinePath = typeof baselinePathOrReport === "string" ? resolve(baselinePathOrReport) : "(in-memory)";
	const baselineBytes = baseline.summary.estimatedClientBytes ?? 0;
	const currentBytes = current.summary.estimatedClientBytes ?? 0;
	const byteDelta = currentBytes - baselineBytes;
	const baselineKeys = new Map(baseline.findings.map((f) => [findingKey(f), f]));
	const currentKeys = new Map(current.findings.map((f) => [findingKey(f), f]));
	const newFindings = [];
	const resolvedFindings = [];
	let unchangedCount = 0;
	for (const [key, finding] of currentKeys) if (baselineKeys.has(key)) unchangedCount++;
	else newFindings.push(finding);
	for (const [key, finding] of baselineKeys) if (!currentKeys.has(key)) resolvedFindings.push(finding);
	const routeDeltas = computeRouteDeltas(baseline, current);
	const budgetBytes = config.thresholds.diffBudgetBytes ?? 0;
	const budgetExceeded = budgetBytes > 0 && byteDelta > budgetBytes;
	return {
		version: "1.0.0",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		baselinePath,
		currentProjectRoot: current.projectRoot,
		byteDelta,
		baselineClientBytes: baselineBytes,
		currentClientBytes: currentBytes,
		routeDeltas,
		newFindings,
		resolvedFindings,
		unchangedCount,
		budgetExceeded
	};
}
function computeRouteDeltas(baseline, current) {
	const baseRoutes = extractRouteBytes(baseline);
	const curRoutes = extractRouteBytes(current);
	const routes = new Set([...baseRoutes.keys(), ...curRoutes.keys()]);
	const deltas = [];
	for (const route of routes) {
		const b = baseRoutes.get(route) ?? 0;
		const c = curRoutes.get(route) ?? 0;
		if (b === c) continue;
		deltas.push({
			route,
			baseline: b,
			current: c,
			delta: c - b
		});
	}
	return deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
function extractRouteBytes(report) {
	const routes = /* @__PURE__ */ new Map();
	for (const f of report.findings) {
		const route = f.evidence.route;
		if (typeof route === "string" && f.estimatedBytes != null) routes.set(route, Math.max(routes.get(route) ?? 0, f.estimatedBytes));
	}
	return routes;
}
function findingKey(f) {
	return `${f.ruleId}|${f.file}|${typeof f.evidence.package === "string" ? f.evidence.package : ""}|${f.message}`;
}
function writeDiffReport(projectRoot, diff) {
	const dir = resolveOutputDir(projectRoot);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "wimb-diff.json"), JSON.stringify(diff, null, 2));
	writeFileSync(join(dir, "wimb-diff.md"), toDiffMarkdown(diff));
}
function exitCodeForDiff(diff, config) {
	if (diff.budgetExceeded) return 1;
	if (config.thresholds.diffFailOnNewFindings !== false && diff.newFindings.some((f) => f.severity === "error")) return 1;
	return 0;
}
function toDiffMarkdown(diff) {
	const lines = [
		"# WIMB Diff Report",
		"",
		`**Baseline:** \`${diff.baselinePath}\``,
		`**Byte delta:** ${formatSignedBytes(diff.byteDelta)} (${formatBytes(diff.baselineClientBytes)} → ${formatBytes(diff.currentClientBytes)})`,
		`**Findings:** +${diff.newFindings.length} / -${diff.resolvedFindings.length} (unchanged ${diff.unchangedCount})`,
		diff.budgetExceeded ? "**Budget:** EXCEEDED" : "**Budget:** ok",
		""
	];
	if (diff.routeDeltas.length > 0) {
		lines.push("## Route deltas", "");
		for (const r of diff.routeDeltas) lines.push(`- \`${r.route}\`: ${formatSignedBytes(r.delta)} (${formatBytes(r.baseline)} → ${formatBytes(r.current)})`);
		lines.push("");
	}
	if (diff.newFindings.length > 0) {
		lines.push("## New findings", "");
		for (const f of diff.newFindings) lines.push(`- **[${f.severity}] ${f.ruleId}** — ${f.file}: ${f.message}`);
		lines.push("");
	}
	if (diff.resolvedFindings.length > 0) {
		lines.push("## Resolved findings", "");
		for (const f of diff.resolvedFindings) lines.push(`- **[${f.severity}] ${f.ruleId}** — ${f.file}: ${f.message}`);
		lines.push("");
	}
	return lines.join("\n");
}
function formatBytes(n) {
	if (Math.abs(n) >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
	if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}
function formatSignedBytes(n) {
	return `${n > 0 ? "+" : ""}${formatBytes(n)}`;
}
//#endregion
//#region ../graph-v1/dist/index.js
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
		pathRouteUsage: /* @__PURE__ */ new Map(),
		outputs: [],
		groups: []
	};
}
function addClientPart(graph, part) {
	if (!part.route) return;
	if (!isClientJavaScriptOutput(part.filename ?? "")) return;
	const path = normalizeModulePath(part.source_path ?? "");
	if (!path) return;
	const bytes = numberOrZero(part.compressed_size) > 0 ? numberOrZero(part.compressed_size) : numberOrZero(part.size);
	let routeMap = graph.clientPartsByRoute.get(part.route);
	if (!routeMap) {
		routeMap = /* @__PURE__ */ new Map();
		graph.clientPartsByRoute.set(part.route, routeMap);
	}
	routeMap.set(path, (routeMap.get(path) ?? 0) + bytes);
	let usage = graph.pathRouteUsage.get(path);
	if (!usage) {
		usage = /* @__PURE__ */ new Set();
		graph.pathRouteUsage.set(path, usage);
	}
	usage.add(part.route);
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
			addClientPart(graph, record);
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
	for (const route of graph.clientPartsByRoute.keys()) if (!graph.routes.has(route)) graph.routes.set(route, {
		type: "route",
		route,
		entries: null,
		coverage: {
			entries: "unknown",
			groups: "unknown"
		}
	});
	return graph;
}
/** Read `.jsonl` or `.jsonl.gz` from disk. */
function parseGraphV1File(filePath) {
	const buf = readFileSync(filePath);
	return parseGraphV1Jsonl(filePath.endsWith(".gz") ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8"));
}
const DEFAULT_MAX_DEPTH = 40;
function routeBytes(graph, route) {
	const parts = graph.clientPartsByRoute.get(route);
	if (!parts) return 0;
	let total = 0;
	for (const bytes of parts.values()) total += bytes;
	return total;
}
function selfBytesForPath(graph, route, path) {
	const parts = graph.clientPartsByRoute.get(route);
	if (!parts) return 0;
	return parts.get(path) ?? 0;
}
function routeCountForPath(graph, path) {
	return graph.pathRouteUsage.get(path)?.size ?? 0;
}
function collectSeeds(graph, routePath) {
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
	if (route?.entries) for (const entry of route.entries) {
		if (entry.entry_kind === "client_bootstrap" || entry.role === "route") push(entry.module_ident, "entry");
		for (const ref of entry.client_references ?? []) if (ref.reference_kind === "ecmascript") push(ref.module_ident, "client_reference");
	}
	if (seeds.length === 0) {
		const parts = graph.clientPartsByRoute.get(routePath);
		if (parts) {
			for (const [path] of parts) for (const mod of graph.modules.values()) if (normalizeModulePath(mod.path) === path) push(mod.ident, "entry");
		}
	}
	return seeds;
}
function walkModule(graph, routePath, ident, edgeKind, ancestors, depth, opts) {
	const mod = graph.modules.get(ident);
	const path = normalizeModulePath(mod?.path ?? ident);
	const label = displayLabel(path);
	const selfBytes = selfBytesForPath(graph, routePath, path);
	const routeCount = routeCountForPath(graph, path);
	if (ancestors.has(ident)) return {
		kind: "module",
		id: ident,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes,
		routeCount,
		edgeKind,
		cycle: true,
		children: []
	};
	if (depth >= opts.maxDepth || !mod) return {
		kind: "module",
		id: ident,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes,
		routeCount,
		edgeKind,
		children: []
	};
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
		children.push(walkModule(graph, routePath, child.ident, child.edgeKind, nextAncestors, depth + 1, opts));
	}
	children.sort((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));
	return {
		kind: "module",
		id: ident,
		label,
		path,
		selfBytes,
		totalBytes: selfBytes + children.reduce((sum, c) => sum + c.totalBytes, 0),
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
		maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH
	};
	const seeds = collectSeeds(graph, routePath);
	const children = [];
	const seenRoot = /* @__PURE__ */ new Set();
	for (const seed of seeds) {
		if (seenRoot.has(seed.ident)) continue;
		seenRoot.add(seed.ident);
		children.push(walkModule(graph, routePath, seed.ident, seed.edgeKind, /* @__PURE__ */ new Set(), 0, opts));
	}
	if (children.length === 0) {
		const parts = graph.clientPartsByRoute.get(routePath);
		if (parts) for (const [path, bytes] of parts) children.push({
			kind: "module",
			id: path,
			label: displayLabel(path),
			path,
			selfBytes: bytes,
			totalBytes: bytes,
			routeCount: routeCountForPath(graph, path),
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
		totalBytes: routeBytes(graph, routePath),
		routeCount: 1,
		children
	};
}
function countModules(node) {
	if (node.kind === "module") return 1 + node.children.reduce((n, c) => n + countModules(c), 0);
	return node.children.reduce((n, c) => n + countModules(c), 0);
}
/** Build the viz payload: route summaries + per-route trees. */
function buildRouteForest(graph, options = {}) {
	const trees = {};
	const routes = [];
	const routePaths = [...graph.routes.keys()].sort();
	for (const routePath of routePaths) {
		const tree = buildRouteTree(graph, routePath, options);
		trees[routePath] = tree;
		routes.push({
			route: routePath,
			totalBytes: tree.totalBytes,
			moduleCount: countModules(tree)
		});
	}
	routes.sort((a, b) => b.totalBytes - a.totalBytes || a.route.localeCompare(b.route));
	return {
		schemaVersion: 1,
		meta: {
			snapshotName: graph.meta?.snapshot_name ?? null,
			routeCount: graph.meta?.route_count ?? routes.length,
			selectedRoutes: graph.meta?.selected_routes ?? routes.length
		},
		routes,
		trees
	};
}
//#endregion
//#region src/viz.ts
function buildVizGraph(opts) {
	return buildRouteForest(parseGraphV1File(opts.analyzeExportPath), {
		includeAsync: opts.includeAsync,
		includeTraced: opts.includeTraced
	});
}
function writeVizGraph(opts) {
	const viz = buildVizGraph(opts);
	const out = resolve(opts.outputPath);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(viz, null, 2)}\n`, "utf-8");
	return viz;
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
					description: "Output formats: json,md,sarif (comma-separated)",
					default: "json,md"
				},
				"exit-threshold": {
					type: "string",
					description: "Exit 1 if findings at or above this severity",
					default: "error"
				},
				e18e: {
					type: "boolean",
					description: "Merge @e18e/cli diagnostics",
					default: false
				},
				"rsc-xray": {
					type: "boolean",
					description: "Merge @rsc-xray/analyzer diagnostics (opt-in)",
					default: false
				},
				baseline: {
					type: "string",
					description: "Compare against a prior wimb-report.json and write wimb-diff.*"
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
					e18e: args.e18e,
					rscXray: args["rsc-xray"],
					baseline: args.baseline,
					forestCompact: args["forest-compact"] || args["no-ast"]
				});
				process.exit(code);
			}
		}),
		diff: defineCommand({
			meta: {
				name: "diff",
				description: "Compare two wimb-report.json files (baseline vs current)"
			},
			args: {
				baseline: {
					type: "positional",
					description: "Path to baseline wimb-report.json",
					required: true
				},
				current: {
					type: "positional",
					description: "Path to current wimb-report.json",
					required: true
				},
				cwd: {
					type: "string",
					description: "Project root for writing wimb-diff.* (defaults to cwd)",
					default: process.cwd()
				}
			},
			async run({ args }) {
				const projectRoot = resolve(args.cwd);
				const config = await loadConfig(projectRoot);
				const diff = compareReports(loadReport(resolve(args.baseline)), loadReport(resolve(args.current)), config);
				writeDiffReport(projectRoot, diff);
				console.log(toDiffMarkdown(diff));
				process.exit(exitCodeForDiff(diff, config));
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
					description: "Build a route-rooted import forest JSON from next analyze export"
				},
				args: {
					"analyze-export": {
						type: "string",
						description: "Path to next analyze export JSONL (.jsonl or .jsonl.gz)",
						required: true
					},
					output: {
						type: "string",
						description: "Output path for viz graph JSON",
						default: ".wimb/bundle-graph.json"
					},
					cwd: {
						type: "string",
						description: "Base directory for relative paths",
						default: process.cwd()
					},
					async: {
						type: "boolean",
						description: "Include async dependency edges",
						default: false
					},
					traced: {
						type: "boolean",
						description: "Include traced (non-bundled) dependency edges",
						default: false
					}
				},
				async run({ args }) {
					const projectRoot = resolve(args.cwd);
					const analyzeExportPath = resolve(projectRoot, args["analyze-export"]);
					const outputPath = resolve(projectRoot, args.output);
					const viz = writeVizGraph({
						analyzeExportPath,
						outputPath,
						includeAsync: args.async,
						includeTraced: args.traced
					});
					console.log(`wimb: wrote ${outputPath} (${viz.routes.length} routes, snapshot ${viz.meta.snapshotName ?? "unknown"})`);
				}
			}) }
		})
	}
}));
//#endregion
export {};
