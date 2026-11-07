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
					"sources": [
						"vendor/7zip/CPP/Common/MyWindows.cpp",
						"vendor/7zip/CPP/Windows/PropVariant.cpp"
					],
					"cflags_cc": ["-pthread"],
					"libraries": [
						"-pthread",
						"-ldl"
					]
				}],
				["OS=='mac'", {
					"sources": [
						"vendor/7zip/CPP/Common/MyWindows.cpp",
						"vendor/7zip/CPP/Windows/PropVariant.cpp"
					],
					"xcode_settings": {
						"CLANG_CXX_LANGUAGE_STANDARD": "c++17",
						"GCC_ENABLE_CPP_EXCEPTIONS": "YES"
					}
				}],
				["OS=='win'", {
					"sources": ["vendor/7zip/CPP/Windows/PropVariant.cpp"],
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
