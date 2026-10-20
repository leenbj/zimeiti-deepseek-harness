"""Vendored third-party code shipped inside the plugin.

Nothing here is imported directly; `engine/__init__.py` puts this directory on `sys.path` so that
`import yaml` resolves to the bundled pure-Python PyYAML when the interpreter does not provide one.
"""
