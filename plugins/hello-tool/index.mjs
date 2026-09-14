// Demo tool plugin for the neutral plugin contract.
//
// A plugin entry exports a factory function that receives the neutral
// `PluginAPI`. Every register* call returns a disposer, which the host
// tracks automatically so the plugin can be hot-unloaded. The factory
// may also return a function for extra cleanup.
export default function helloTool(api) {
  api.registerTool({
    name: "hello",
    description: "根据传入的名字返回一句中文问候。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "要问候的名字。" },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      const name = typeof args?.name === "string" ? args.name : "世界";
      return {
        content: [{ type: "text", text: `你好，${name}！` }],
        details: { agent: ctx?.agent },
      };
    },
  });
}
