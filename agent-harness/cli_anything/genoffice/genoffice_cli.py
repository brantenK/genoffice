"""Reduced, authenticated GenOffice harness CLI."""

from __future__ import annotations

import json
import re
import shlex
import time
from pathlib import Path

import click

from . import __version__
from .core.errors import HarnessError
from .core.launcher import Launcher
from .core.session import default_session_path
from .utils.repl_skin import ReplSkin


class JsonCommand(click.Command):
    def parse_args(self, ctx, args):
        try:
            return super().parse_args(ctx, args)
        except click.UsageError as exc:
            if ctx.find_root().params.get("json_output") or "--json" in args:
                click.echo(json.dumps({"ok": False, "error": {"code": "CLI_USAGE", "message": str(exc)}}))
                raise click.exceptions.Exit(2)
            raise


class JsonGroup(click.Group):
    """Ensure root and nested parser failures obey the JSON stdout contract."""

    command_class = JsonCommand

    def parse_args(self, ctx, args):
        try:
            return super().parse_args(ctx, args)
        except click.UsageError as exc:
            if ctx.find_root().params.get("json_output") or "--json" in args:
                click.echo(json.dumps({"ok": False, "error": {"code": "CLI_USAGE", "message": str(exc)}}))
                raise click.exceptions.Exit(2)
            raise

    def resolve_command(self, ctx, args):
        try:
            return super().resolve_command(ctx, args)
        except click.UsageError as exc:
            if ctx.find_root().params.get("json_output") or "--json" in args:
                click.echo(json.dumps({"ok": False, "error": {"code": "CLI_USAGE", "message": str(exc)}}))
                raise click.exceptions.Exit(2)
            raise


def _json_enabled(ctx) -> bool:
    root = ctx.find_root()
    return bool(root.params.get("json_output")) or bool(ctx.params.get("local_json"))


def _success(ctx, result: dict):
    if _json_enabled(ctx):
        click.echo(json.dumps({"ok": True, "result": result}, ensure_ascii=False, sort_keys=True))
    else:
        for key, value in result.items():
            click.echo(f"{key}: {value}")
    return result


def _failure(ctx, error: Exception):
    code = getattr(error, "code", "CLI_ERROR")
    message = str(error)
    details = getattr(error, "details", {})
    if _json_enabled(ctx):
        click.echo(json.dumps({"ok": False, "error": {"code": code, "message": message, **details}}, ensure_ascii=False))
    else:
        click.echo(f"Error [{code}]: {message}", err=True)
    raise click.exceptions.Exit(1)


def _launcher(ctx, **target) -> Launcher:
    root = ctx.find_root()
    return Launcher(session_path=root.params.get("session_path"), **target)


def _request(ctx, command: str, payload=None):
    try:
        return _success(ctx, _launcher(ctx).request(command, payload or {}))
    except (HarnessError, OSError) as error:
        return _failure(ctx, error)


def _validate_screenshot_tab_id(tab_id: str) -> None:
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", tab_id) is None:
        raise HarnessError("screenshot tab ID is invalid", "SCREENSHOT_TAB_INVALID")


def _validate_screenshot_name(name: str) -> None:
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,59}\.png", name, re.IGNORECASE) is None:
        raise HarnessError("screenshot name is invalid", "SCREENSHOT_NAME_INVALID")


@click.group(cls=JsonGroup, invoke_without_command=True, context_settings={"help_option_names": ["-h", "--help"]})
@click.option("--json", "json_output", is_flag=True, help="Emit one machine-readable JSON object.")
@click.option("--session", "session_path", type=click.Path(path_type=Path), default=None, help="Session selector path.")
@click.version_option(__version__, prog_name="cli-anything-genoffice")
@click.pass_context
def cli(ctx, json_output, session_path):
    """Control the real GenOffice shell through its local typed automation API."""
    ctx.ensure_object(dict)
    ctx.obj.update(json_output=json_output, session_path=session_path or default_session_path())
    if ctx.invoked_subcommand is None:
        if json_output:
            click.echo(json.dumps({"ok": False, "error": {"code": "CLI_USAGE", "message": "--json requires a command"}}))
            raise click.exceptions.Exit(2)
        _repl(ctx)


@cli.group(cls=JsonGroup)
def app():
    """Start or inspect GenOffice."""


@app.command("start")
@click.option("--app-path", type=click.Path(path_type=Path), default=None, help="Explicit packaged Electron executable.")
@click.option("--electron-path", type=click.Path(path_type=Path), default=None, help="Explicit source-shell Electron runtime.")
@click.option("--app-dir", type=click.Path(path_type=Path), default=None, help="Explicit source-built shell app directory.")
@click.option("--json", "local_json", is_flag=True, hidden=True)
@click.pass_context
def app_start(ctx, app_path, electron_path, app_dir, local_json):
    try:
        _success(ctx, _launcher(ctx, app_path=app_path, electron_path=electron_path, app_dir=app_dir).start())
    except (HarnessError, OSError) as error:
        _failure(ctx, error)


@app.command("status")
@click.option("--json", "local_json", is_flag=True, hidden=True)
@click.pass_context
def app_status(ctx, local_json):
    _request(ctx, "app.status")


@cli.group(cls=JsonGroup)
def tabs():
    """Inspect and safely navigate existing shell tabs."""


@tabs.command("list")
@click.option("--json", "local_json", is_flag=True, hidden=True)
@click.pass_context
def tabs_list(ctx, local_json):
    _request(ctx, "tabs.list")


@tabs.command("activate")
@click.argument("tab_id")
@click.option("--json", "local_json", is_flag=True, hidden=True)
@click.pass_context
def tabs_activate(ctx, tab_id, local_json):
    _request(ctx, "tabs.activate", {"tabId": tab_id})


@cli.group(cls=JsonGroup)
def files():
    """Open DOCX fixtures from the private session input root or list recents."""


@files.command("open")
@click.argument("path", type=click.Path(path_type=Path))
@click.option("--json", "local_json", is_flag=True, hidden=True)
@click.pass_context
def files_open(ctx, path, local_json):
    try:
        safe_path = _launcher(ctx).input_path(path)
        _success(ctx, _launcher(ctx).request("files.open", {"path": str(safe_path)}))
    except (HarnessError, OSError) as error:
        _failure(ctx, error)


@files.command("recent")
@click.option("--json", "local_json", is_flag=True, hidden=True)
@click.pass_context
def files_recent(ctx, local_json):
    _request(ctx, "files.recent")


@cli.group(cls=JsonGroup)
def screenshots():
    """Capture PNG screenshots from an open GenOffice page."""


@screenshots.command("capture")
@click.option("--tab", "tab_id", default=None, help="Open tab ID to capture.")
@click.option("--name", "name", default=None, help="PNG filename for the capture.")
@click.option("--json", "local_json", is_flag=True, hidden=True)
@click.pass_context
def screenshots_capture(ctx, tab_id, name, local_json):
    try:
        if tab_id is not None:
            _validate_screenshot_tab_id(tab_id)
        if name is not None:
            _validate_screenshot_name(name)
        payload = {}
        if tab_id is not None:
            payload["tabId"] = tab_id
        if name is not None:
            payload["name"] = name
        _request(ctx, "screenshots.capture", payload)
    except HarnessError as error:
        _failure(ctx, error)


def _repl(ctx):
    selected_session = str(ctx.find_root().params["session_path"])
    skin = ReplSkin("genoffice", version=__version__)
    skin.print_banner()
    prompt_session = skin.create_prompt_session()
    commands = {
        "app start|status": "Manage the real Electron shell",
        "tabs list|activate": "Inspect or navigate existing tabs",
        "files open|recent": "Open a session DOCX fixture or inspect recents",
        "screenshots capture": "Capture a PNG from an open page",
        "quit": "Exit the REPL",
    }
    while True:
        try:
            line = skin.get_input(prompt_session)
        except (EOFError, KeyboardInterrupt):
            skin.print_goodbye()
            return
        if not line:
            continue
        if line in {"quit", "exit"}:
            skin.print_goodbye()
            return
        if line == "help":
            skin.help(commands)
            continue
        try:
            args = ["--session", selected_session, *shlex.split(line)]
            cli.main(args=args, prog_name="cli-anything-genoffice", standalone_mode=False)
        except click.exceptions.Exit:
            pass
        except (click.ClickException, HarnessError) as error:
            skin.error(str(error))


def main():
    cli(prog_name="cli-anything-genoffice")


if __name__ == "__main__":
    main()
