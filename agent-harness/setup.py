from setuptools import find_namespace_packages, setup


setup(
    name="cli-anything-genoffice",
    version="0.1.0",
    description="Authenticated CLI harness for the GenOffice Electron shell",
    packages=find_namespace_packages(include=["cli_anything.*"]),
    include_package_data=True,
    package_data={
        "cli_anything.genoffice": [
            "README.md", "skills/*.md", "THIRD_PARTY_NOTICES.md", "LICENSE-APACHE-2.0",
        ],
    },
    install_requires=["click>=8.0", "prompt-toolkit>=3.0"],
    entry_points={
        "console_scripts": [
            "cli-anything-genoffice=cli_anything.genoffice.genoffice_cli:main",
        ]
    },
    python_requires=">=3.10",
)
