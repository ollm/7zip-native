{
	"targets": [
		{
			"target_name": "7zip_native",
			"sources": ["native/addon.cpp"],
			"include_dirs": [
				"<!@(node -p \"require('node-addon-api').include\")",
				"vendor/7zip/CPP"
			],
			"dependencies": [
				"<!(node -p \"require('node-addon-api').gyp\")"
			],
			"defines": ["NAPI_CPP_EXCEPTIONS"],
			"cflags_cc": ["-std=c++17"],
			"cflags_cc!": ["-fno-exceptions"],
			"conditions": [
				["OS=='linux'", {
					"cflags_cc": ["-pthread"],
					"libraries": [
						"-pthread",
						"-ldl",
						"-L<(module_root_dir)/vendor/7zip/CPP/7zip/Bundles/Format7zF/_o",
						"-l:7z.so",
						"-Wl,-rpath,'$$ORIGIN'"
					]
				}],
				["OS=='mac'", {
					"libraries": [
						"-L<(module_root_dir)/vendor/7zip/CPP/7zip/Bundles/Format7zF/_o",
						"-l7z",
						"-Wl,-rpath,@loader_path"
					],
					"xcode_settings": {
						"CLANG_CXX_LANGUAGE_STANDARD": "c++17",
						"GCC_ENABLE_CPP_EXCEPTIONS": "YES"
					}
				}],
				["OS=='win'", {
					"libraries": ["OleAut32.lib"],
					"msvs_settings": {
						"VCCLCompilerTool": {
							"ExceptionHandling": 1,
							"AdditionalOptions": ["/std:c++17"]
						}
					}
				}]
			]
		}
	]
}
