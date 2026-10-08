// The toy engine does nothing: every tool answers which tool ran, for which project.
export async function activate() {
  return {
    async tool(name, _args, ctx) {
      return { tool: name, project: ctx.project };
    },
  };
}
