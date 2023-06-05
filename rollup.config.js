import svelte from "rollup-plugin-svelte";
import sveltePreprocess from "svelte-preprocess";
import { vitePreprocess } from '@sveltejs/kit/vite';
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import nodePolyfills from 'rollup-plugin-polyfill-node';
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import css from "rollup-plugin-css-only";
import serve from "rollup-plugin-serve";
import json from "@rollup/plugin-json";
import livereload from "rollup-plugin-livereload";
import { terser } from "rollup-plugin-terser";
import esformatter from "rollup-plugin-esformatter";
import postcss from "rollup-plugin-postcss";

const production = true; //false;// !process.env.ROLLUP_WATCH;

export default {
	input: "src/widget.js",
	output: {
		file: "static/public/bundle.js",
		format: "iife",
		name: "app",
		sourcemap: production,
		globals: {
			"https": "https",
			"http": "http",
			"net": "net",
		}

	},
	plugins: [
		// compile svelte with tailwindcss as preprocess (including autoprefixer)
		svelte({
			preprocess: [
				sveltePreprocess({
					sourceMap: !production,
					postcss: {
						plugins: [tailwindcss(), autoprefixer()],
					},
				}),
				vitePreprocess(),
			],
		}),

		// resolve external dependencies from NPM
		resolve({
			browser: true,
			dedupe: ["svelte"],
			preferBuiltins: false
		}),
		json(),
		commonjs(),
		nodePolyfills( /* options */ ),

		// export CSS in separate file for better performance
		css({ output: "bundle.css" }),
		// postcss({
		// 	config: {
		// 		path: "./postcss.config.js",
		// 	},
		// 	extensions: [".css"],
		// 	minimize: true,
		// 	inject: {
		// 		insertAt: "top",
		// 	},
		// }),

		// start a local livereload server on public/ folder
		!production && serve("public/"),
		!production && livereload("public/"),

		// minify bundles in production mode
		production && terser(),
	],
};
