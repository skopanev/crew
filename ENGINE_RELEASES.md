# Engine releases

Use the public repository's remote `main` as the source of truth.
Install a recorded `engine-vN` tag. Never move or reuse a release tag.
Project configuration and role code remain in their own repository.

Each annotated tag identifies one source commit and contains its short changelog.
The table below records the initial versions found in installed clean runtimes.
Version numbers follow those commits' recorded dates. They do not imply API compatibility.
Old versions remain available for existing panels.

| Version | Source commit | Change |
| --- | --- | --- |
| engine-v1 | `706045a03db506d99a8cb7f53da8f72cfd2c86af` | Refuse legacy module configs and preserve prior recovery roots |
| engine-v2 | `ce347d179504d73dbefc3c185e562bafeb8970c2` | Reject an invalid assignment mode before failure cleanup |
| engine-v3 | `8d000d8fb6451d6a0325ece6ecf5cc97ba585aa7` | Prevent concurrent workers with overlapping configured contexts |
| engine-v4 | `64680e12da315e3c3bb64ef5cf7fe17708e65816` | Show the recorded planning verdict in terminal status rows |
| engine-v5 | `ba55ce20f975f1c4dac43fa909b65e3164564d5c` | Remove the selected item message from planning panels |
| engine-v6 | `6caf514b5f6148e884d6075b927e14e4af01f303` | Skip assigned planning items and count refused claims safely |
| engine-v7 | `dff342397a00b01135d6a1b24140000ee5f36d74` | Preserve all critic findings in failed flow notes |
| engine-v8 | `838fb2ae78655b3b2e5102e94cf5c95c48bd1502` | Keep lane completion writes within its claimed Tasks |
| engine-v9 | `b6d1cc14117a1e28c3d4e81ca53267080024f7bc` | Recognize saved claims from the previous contract digest format |
| engine-v10 | `61753bb5675a3fa1cf69ad5efae383a9e792b178` | Refuse a claimed object save that uses a late create |
| engine-v11 | `cbee1bb6e6b10840bfac3e906e003174ee303e26` | Describe structured Tasker critic findings in the output contract |
| engine-v12 | `f17221a5bcd37a0206987fbf54f6cd6ff009c5b5` | Show Tasker owner questions as complete readable choices |
| engine-v13 | `d4ac68d96c26b54aebd09460d0fbade6b938fee6` | Keep audit finders within the supplied prompt |
| engine-v14 | `78d553e51361bcd71a5bf4f1efa7fda3851162de` | Return invalid evidence quotes to the Decider author once |
| engine-v15 | `424282cb29bab38a5b1167605c9d53af3fa52fc9` | Allow configured structural reads within the Decider root |
| engine-v16 | `291e31c39da27b2078dc28416bc72afbbc8c3581` | Retry one failed MCP connection before tool calls |
| engine-v17 | `889eb663596fad9dcff67739c00d98938cbc21be` | Ignore late MCP responses after request timeouts |
| engine-v18 | `2d97ccaefd7adf6f500115ff1f07db33eb3e9726` | Allow configured absolute host hooks after landing |
| engine-v19 | `2f045bbfb969a30464eb02460659f0d61747f527` | Let configured Lane roles use their own complete instruction files |
| engine-v20 | `f70840edf3632892550c0add2dd0ea61849418dd` | Check the actual retry export with longer artifact paths |
| engine-v21 | `5e23afa65be4ce4c5884c5f711276c33a2ff0990` | Read Source attachments through the common Reader |
| engine-v22 | `505bd3176e2cac60d5340c891893b9859183ff7f` | Keep relation reads free of object list default fields |
| engine-v23 | `6cc77f867eec732a36a153036ea6b2d16251a6ea` | Match AGY native file reads to the declared reader grants |
| engine-v24 | `ca6911499edae2004ba9c028ede1212c5672744f` | Align Tasker role instructions with the approved DONE rule |
| engine-v25 | `2869bb6af1836bc16e6874d126d1bd8b61cb6e97` | Keep the return stage when Tasker marks an AC stuck |
| engine-v26 | `7925c43a829fecb6465cc93a50000f989688f78a` | Compare the archived prerequisite with its frozen test snapshot |
| engine-v27 | `bad8dccc14c04f569573b57cecbeab03d6c3e24a` | Observe planner queue reads instead of removed footer messages |
| engine-v28 | `2f8f1311ffa1095460dc5da1c9c25b2428a94011` | Repeat only the exact Joppa maintenance answer |
| engine-v29 | `7c78acbf7cbc5ea766a19a66fc1373e384006c61` | Check question tags during Requirement finalization |
| engine-v30 | `d6f57b7a4f716ccbca42065f7d7287497c462156` | Hide completed Tasker selection skips from the panel |
| engine-v31 | `e94905b7febb4d6b877abe1d2bf25e21e11a3643` | Mark the passing Test fixture as present |
| engine-v32 | `2682cc70f77f74b572c1c393e651e93983088cbd` | Require the typed owner question for a Tasker DECISION_REQUIRED |
| engine-v33 | `eda7315384c12baf525b1f98baa268e2149017d0` | Keep an archived prerequisite without a commit visible as blocked |
| engine-v34 | `65087e6bd521df0ee9b439b26cbae00490b2c217` | Reserve the empty line before panel controls |
| engine-v35 | `068f7f04f35cf3c7f954e96fd609bcb13fca2330` | Keep Tasker guards and test modules within the line limit |
| engine-v36 | `532fb8dac1f857027281d19edcfbee0862efde67` | Resolve complete code link chains with the native filesystem |
| engine-v37 | `808cfac483657d753c77a5b5efb320181482fe27` | Keep role labels separate from configured paths |
| engine-v38 | `e9324d387aaac4b3a7ef2e5a563a0db32c537c98` | Keep role labels separate from configured paths |
| engine-v39 | `e68adc8662c1979bb5ecd7920c406759253a4b36` | Keep excluded Lander branches pending for separate repair |
| engine-v40 | `4c015ff90c438bcb86a3d1f80179094e107dcfe9` | Keep red pending review Tasks as evidence without blocking replacement planning |
| engine-v41 | `5ef7aa9035daf7a70af9693fbf14b0b5f852a9f3` | Keep the active Task stages unchanged when applying the repair exception |
| engine-v42 | `167497aff3578a60e4ebec67f67dfb071dcbf2d1` | Resolve recorded Test files from the command directory |
| engine-v43 | `01fd1f7b60e28eff61a5d965a9a6b19c99d67c00` | Disable host maintenance when lane launches are disabled |
| engine-v44 | `6899a587577fcbc72365ae3362e498d7dbffad68` | Limit dependency replan to admission and preserve preview |
| engine-v45 | `06d23370e96e88cd16a5235c7a908bab31ea489e` | Complete configured criteria after confirmed Lander publication |
| engine-v46 | `f25b394f9d872ed4df175165d2e98c92672bfe01` | Recover criterion completion writes and preserve publication outcomes |
| engine-v47 | `91041225db6b9310aa7ba6c9c1529ca2d4b563d8` | Complete criteria after confirmed Task landing |
| engine-v48 | `1dda65c689c96ff0131078ac579f19cbc30b587d` | Configure Lander deadlines and cleanup permission failures |
| engine-v49 | `366ad1bcf890319d82c489216ef0d6ac0a8b2bf3` | Require workflow support before applying a configured deadline |
| engine-v50 | `802406840dd6458638f2522909d60fe8d0bd363d` | Handle macOS nonempty results after restricted checkout removal |
| engine-v51 | `1753afc8ca7c9495418598e337603144f2a903a2` | Configure Lander deadlines and remove restricted checkouts |
| engine-v52 | `33403a0620a53a6e3cb3515b17950367ca996847` | Recover externally released flow claims without tracker writes |
| engine-v53 | `a2200806ad19861e9f303a3a4e1eae1b577add84` | Require the original failure result for manual flow recovery |
| engine-v54 | `f78984926acd83fa9472a478be373799b9671f8d` | Recover ended flow claims and preserve externally updated work |
| engine-v55 | `1263c76d046e7353b8d5bed75946a228e3793750` | Use the workflow budget for repository setup |
| engine-v56 | `6ea7c5995503232f84b587fcbf7da36dc0b1e49c` | Clean dispatcher resources when worker shutdown fails |
| engine-v57 | `5eed9c74935e583d9b0b9b3851bfde7e0049e6c6` | Configure retry policy and delay for workflow refusal reasons |
| engine-v58 | `19de14e2e1bf1b8e6401d37b4f8e23757db28d76` | Preserve existing skips while requiring every executed identity to pass |
| engine-v59 | `69acbf7898f5455d5b96dfff86562e996b30b72a` | Retry failed test files on the verified candidate tree |
| engine-v60 | `5f2fe6fb39a5818fee8bfac5cd60d80ee0771e4c` | Show confirmed branch handoffs as DONE and display batch Tasks |
| engine-v61 | `727d8cd7d81f3dad5dc709c5f4129bb3786d4b67` | Keep Lander assignment data in files and preserve blocked signals |
| engine-v62 | `eb4dd69a83bdb5eb5d3b47db1c01b51e98e630d1` | Flush small batches when producers are idle and show grouped queues during active work |
| engine-v63 | `50930d376414c0e5327472f076021b31c8d3eb52` | Read Test execution policy from the injected shared rule in Tasker and Lane review prompts |
| engine-v64 | `d3f174997f2d28891ea48e4d5c4e857465190293` | Run filtered slots in one dashboard and check effective object filters before claims |
| engine-v65 | `a2c9d5017f342b0a4cb7df2a78601359dd4e2a17` | Show the slot and count in batch rows and preserve stored Task identities |
| engine-v66 | `aa17a31d616aa687532f1025d3bf02a258007371` | Allow each configured slot to override common batch settings |
| engine-v67 | `e51c109298c90b75f6a397eeeec2177588bd44f3` | Check configured admission before selecting or claiming flow inputs |
| engine-v68 | `2a8385a1b42d13bcd823205f0a4b683b58aecf8c` | Keep admission diagnostics in the flow output log |
| engine-v69 | `691f6f658d9ae037d31edef5b6cffd2dd50a1904` | Allow a parent note after its guarded stage update |
| engine-v70 | `28c2c64f10488c3b4bcde395ccd9bf8db341935e` | Count active and waiting units and keep admission readers stable per pass |
| engine-v71 | `7df6cb6b075b4ad7b08354d47ad8d9a11f70918f` | Show native candidate counts per configured profile and admission skips |
| engine-v72 | `0f1592048d1711b86cb45d34a26b7b2a83d35b2a` | Retry failed target confirmation reads after a successful lane push |
| engine-v73 | `bcaa0ebb3d2d51e23f66ff4ea2f43d381902134a` | Show native availability in Dolber and Lander dashboards and monitors |
| engine-v74 | `c3a8c9ea8e5358cfac1ee596763d95a42bf721b4` | Retry branch pushes with PUSH_FAILED and show queued units in the header |
| engine-v75 | `c106ba7ce7da2c21290f0fb5013cc1624e8eb9b5` | Request one eligible Lander batch below its minimum with a durable one-time flush |
| engine-v76 | `d2253f6684b84b88241e1bc3f840503166319dd3` | Show six-hour successful completion rates in every dashboard header |
| engine-v77 | `f81a91161c908d3166c6720e8756152b76233b5f` | Read typed Test Reporter fields and refuse invalid bindings |

The `engine-v77` runtime is `/Users/finik/Projects/crew/releases/engine-v77`.
No panel uses this runtime at publication. The operator must select it for new claims.

## Install a version

Fetch the public repository and its tags. Create a detached runtime at the selected version:

```sh
git fetch origin main --tags
git worktree add --detach /path/to/releases/engine-v76 engine-v76
```

Set `sources.engine.ref` to that tag in the environment specification.
Set `sources.role.ref` to the required role version.
Run the existing installer without `--run` to prepare the environment:

```sh
node /path/to/releases/engine-v76/lane-launcher/environment.mjs /path/to/environment.json
```

Check the returned `environment.json` before starting the panel.
Its source commits identify the installed engine and role code.
A dashboard driver and its workflow can use different versions. Record both.
Existing panels and workers retain their paths until the operator replaces them.

## Publish the next version

1. Merge the reviewed change into remote `main`.
2. Assign the next unused number to the exact source commit.
3. Create an annotated tag with a short changelog and push that tag.
4. Install the tag in a clean detached runtime.
5. Record the tag, source commit, runtime path, and panel that uses it.

Do not publish a tag for a modified checkout or an unrelated repository.
Preserve such checkouts until their contents and owners are known.

