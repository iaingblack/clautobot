I want to try and automate a process that I have and use Claude prompts to do so. The process is basically to automate the following;

 - I want to ultimately run an Octopus Deploy runbook on a local octopus deploy server. The task is unimportant, just getting to it is the key.
- I want to start from a prompt that triggers a skill called create-evidence-file which will be a fake 'change' on a real system (the octpus server itself is fine). It should take a keyword as the content it shold insert into the file
- The process claude should initiate is to create a Jira ticket (method unknow, mcp or api? this is jira cloud, so not local), then put in details. Then wait for it to be approved. Then claude can run an octopus runbook via the MCP protocol which will run the task to create the file
- Claude will then close teh Jira ticket when the Octopus runbook has successfullly completed.

Could we create a CLaude.md file to start discussing this and a plan on next steps. A key factor is how we drive this and monitor it. Command line? We create a small website for each task? Think longer term and imagin us building this up to do more tasks over time.