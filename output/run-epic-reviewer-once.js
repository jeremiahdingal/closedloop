const { runEpicReviewerAgent } = require('../dist/epic-reviewer-agent');
runEpicReviewerAgent().then(() => {
  console.log('done');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
