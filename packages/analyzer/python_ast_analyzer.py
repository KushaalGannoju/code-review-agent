#!/usr/bin/env python3
import ast
import json
import re
import sys
from pathlib import Path


class PythonAnalyzer(ast.NodeVisitor):
    def __init__(self, source):
        self.source = source
        self.findings = []
        self.functions = []
        self.imports = set()
        self.dynamic_sql_variables = set()

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.add(alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module:
            self.imports.add(node.module)
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        self._record_function(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self._record_function(node)
        self.generic_visit(node)

    def visit_Call(self, node):
        name = call_name(node.func)
        if name in {"eval", "exec"}:
            self.add_finding(
                "Unsafe dynamic code execution",
                "critical",
                "security",
                node.lineno,
                f"`{name}` can execute attacker-controlled input.",
                "Replace dynamic execution with explicit parsing or a safe command map.",
            )

        if name in {"pickle.load", "pickle.loads"}:
            self.add_finding(
                "Unsafe deserialization",
                "high",
                "security",
                node.lineno,
                "Pickle can execute code when loading untrusted data.",
                "Use JSON or another safe format for untrusted input.",
            )

        if name in {"subprocess.call", "subprocess.run", "subprocess.Popen"}:
            for keyword in node.keywords:
                if keyword.arg == "shell" and isinstance(keyword.value, ast.Constant) and keyword.value.value is True:
                    self.add_finding(
                        "Shell execution enabled",
                        "high",
                        "security",
                        node.lineno,
                        "Running subprocesses with shell=True increases command injection risk.",
                        "Pass commands as argument arrays and keep shell=False.",
                    )

        if name.endswith(".execute") and node.args:
            first_arg = node.args[0]
            if isinstance(first_arg, (ast.JoinedStr, ast.BinOp)) or (
                isinstance(first_arg, ast.Name) and first_arg.id in self.dynamic_sql_variables
            ):
                self.add_finding(
                    "Possible SQL injection",
                    "high",
                    "security",
                    node.lineno,
                    "SQL appears to be built through string formatting or concatenation.",
                    "Use parameterized queries from the database driver.",
                )

        self.generic_visit(node)

    def visit_Assign(self, node):
        if looks_like_dynamic_sql(node.value):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.dynamic_sql_variables.add(target.id)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        if node.type is None:
            self.add_finding(
                "Bare exception handler",
                "medium",
                "correctness",
                node.lineno,
                "A bare except can hide bugs and make failures difficult to debug.",
                "Catch specific exception types and handle them intentionally.",
            )
        elif isinstance(node.type, ast.Name) and node.type.id == "Exception":
            self.add_finding(
                "Broad exception handler",
                "low",
                "maintainability",
                node.lineno,
                "Catching Exception broadly can hide unrelated failures.",
                "Catch the narrowest exception type expected by this block.",
            )

        if len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
            self.add_finding(
                "Swallowed exception",
                "medium",
                "correctness",
                node.lineno,
                "This handler ignores the error completely.",
                "Log the exception or return a clear failure path.",
            )

        self.generic_visit(node)

    def _record_function(self, node):
        complexity = estimate_complexity(node)
        self.functions.append(
            {
                "name": node.name,
                "line": node.lineno,
                "complexity": complexity,
            }
        )
        if complexity >= 12:
            self.add_finding(
                "High function complexity",
                "high" if complexity >= 18 else "medium",
                "maintainability",
                node.lineno,
                f"{node.name} has a cyclomatic complexity estimate of {complexity}.",
                "Split the function into smaller helpers and isolate branching rules.",
            )

    def add_finding(self, title, severity, category, line, message, recommendation):
        self.findings.append(
            {
                "id": f"py-{line}-{len(self.findings)}",
                "title": title,
                "severity": severity,
                "category": category,
                "line": line,
                "message": message,
                "recommendation": recommendation,
            }
        )


def estimate_complexity(node):
    complexity = 1
    branch_nodes = (
        ast.If,
        ast.For,
        ast.AsyncFor,
        ast.While,
        ast.Try,
        ast.ExceptHandler,
        ast.IfExp,
        ast.BoolOp,
        ast.Match,
        ast.comprehension,
    )
    for child in ast.walk(node):
        if isinstance(child, branch_nodes):
            complexity += 1
    return complexity


def call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def looks_like_dynamic_sql(node):
    if not isinstance(node, (ast.JoinedStr, ast.BinOp)):
        return False
    text = ast.unparse(node).upper()
    return any(keyword in text for keyword in ("SELECT", "INSERT", "UPDATE", "DELETE"))


def scan_secrets(source):
    findings = []
    patterns = [
        re.compile(r"(api[_-]?key|secret|password|token)\s*[:=]\s*[\"'][^\"']{12,}[\"']", re.I),
        re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ]
    for index, line in enumerate(source.splitlines(), start=1):
        if any(pattern.search(line) for pattern in patterns):
            findings.append(
                {
                    "id": f"py-secret-{index}",
                    "title": "Possible hardcoded secret",
                    "severity": "critical",
                    "category": "security",
                    "line": index,
                    "message": "Sensitive credentials should not be stored in source code.",
                    "recommendation": "Move the value into environment variables and rotate the exposed credential.",
                }
            )
    return findings


def main():
    file_path = Path(sys.argv[1])
    source = file_path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    analyzer = PythonAnalyzer(source)
    analyzer.visit(tree)
    analyzer.findings.extend(scan_secrets(source))
    max_complexity = max((item["complexity"] for item in analyzer.functions), default=0)
    print(
        json.dumps(
            {
                "imports": sorted(analyzer.imports),
                "functions": analyzer.functions,
                "findings": analyzer.findings,
                "maxComplexity": max_complexity,
            }
        )
    )


if __name__ == "__main__":
    main()
