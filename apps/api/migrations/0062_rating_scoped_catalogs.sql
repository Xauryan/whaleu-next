-- M3B typed source/catalog foundation. No provider, adoption, capability or
-- runtime activation is seeded. Historical migration bytes remain immutable.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

-- Exact accepted installed function bodies; unexpected baselines stop before DDL.
DO $fingerprint$ DECLARE item record;n integer;actual text;BEGIN
 FOR item IN SELECT * FROM (VALUES
('whaleu_community.advance_rating_review_binding_epoch','389f188e508e8ec782182307dea01085d68a9c72a0a91f6bb9f62e000a537f9a'),
('whaleu_community.advance_rating_review_epoch','91b374bc2545a2e027a32d78db38e4a694d351472146670c45bdff6485eb4cef'),
('whaleu_community.guard_rating_review_binding_epoch','2fa4a281c69befafc5c8f1a37b648892a2ecb642d08213cd0ff713b8b5de4f18'),
('whaleu_community.guard_rating_review_epoch','3b6df1401a552050301f67c0805acf250eae2908046d623d2df28574679097d4'),
('whaleu_community.rating_category_base_binding_validate','d6252187cf5c995512671411b0ddce0027518741f847d04d0f236ad2c5eae28d'),
('whaleu_community.rating_category_base_current','5106a8ae9d52a3e1c36c658c811a339d9e30e80889249c80d18020e5922408f3'),
('whaleu_community.rating_category_decision_current','6910fdb4963e92772f2a9b8b954bd37a9b4b7d8b264a7ebb389b73d6d9a90004'),
('whaleu_community.rating_category_envelope_shape','fde117add3b3772f3b781438cc912382e503f3c4a0de7e7c4bf0e6fb737484c6'),
('whaleu_community.rating_category_ids','487805edc8dd4f9aa32bb3d20a2c4ddaafab3821f00d9138f249ef9da1f729c1'),
('whaleu_community.rating_category_keys','f3b0a24c0702a829ba450599a577ee35e78925705f256b282a6ccc6dd5012092'),
('whaleu_community.rating_envelope_shape','2fe858f6d56483ed48de1b652fe438c01a596678ddb9ac95cfece21f3f5e0b70'),
('whaleu_community.rating_review_binding_validate','20421ef789f730b8be8af8924d7c100505d40541b789e70a6bd2a80b982b0792'),
('whaleu_community.rating_review_head_validate','b9b284d6c77969ca343ca5b2b01dbf1455978213c89ee786d273eb5927d597ca'),
('whaleu_community.rating_target_definition_binding_validate','68bf3ea694106734e4893e6a90500946b6f59c3c5b9744d88dec0c7d98b0c921'),
('whaleu_community.rating_target_definition_current','28a01a032004dfbf2942b456b25d00a4a129a44fed0a7c312e7d954414e38937'),
('whaleu_community.rating_target_edit_envelope_shape','21dfa998ace24dff65e85e472673925a9303dd34c3ed011c8818f59861024fb4'),
('whaleu_community.rating_target_edit_text_valid','429414b51c501ff6e31839b652cb3ef66676eaf3cb6f040b50666833cc97c8c6'),
('whaleu_community.rating_target_edit_uuid_valid','82c4c3603f1b0bf53c91af7ad768128d08aa68aff83bc7a9e2d47d99d0015794'),
('whaleu_ratings.admin_delete_audit_complete','78820cf36a57c7afe5008d5e2aab11c62ea56e489800ea3a4871cf7e39c88a6f'),
('whaleu_ratings.admin_delete_audit_guard','8148002b67c7b7561e367e8998b44e371cd883cef937c8548778c3c8750e4a9a'),
('whaleu_ratings.admin_delete_cause','e5eeafcf03627cfefea96a5f7e2f8a2deba47ae4d8d0efdaf8ba9abd113a25f5'),
('whaleu_ratings.admin_delete_effect_guard','b6e9d8ed0c38ab1ed4334413a953d57774aaef74eb3a6576f2b661686a74a4b9'),
('whaleu_ratings.admin_request_causal','36e6a6aa67c8483452a8565c8ec5cec1f5e6c7b751c4d606728ea3faf0878ee5'),
('whaleu_ratings.advance_like_state','0810ccb9b91bc231a31ddd6322a5076a81a7d9a75372526067dc9a24a85a4810'),
('whaleu_ratings.advance_navigation_epoch','b8cbaca0c743e1ce4070157cf8f130f0a23ebbba1e948c44e73bdc4460164fd0'),
('whaleu_ratings.advance_random_pool_epoch','bb15ddfb13259c2dd1693377a04244635a4f4977f7bfc93a003c094505791844'),
('whaleu_ratings.advance_reply_head','ee831b6968014995c54e43d3117e469c23f85a670a31efbdcd2ebb1385bd42f0'),
('whaleu_ratings.advance_subscription_stream','d664f19d97305e06b20199e17f8c4e3753aa27b6697ee76b797436208bdd55b9'),
('whaleu_ratings.apply_score_transition','a8377a1ca3482e705c77618351782e81b68efdf572596c7ab3feaf080c763d0c'),
('whaleu_ratings.assert_category_context','a79abcc613450a06b5de65be1a021a583cf1197fbaaf536bb134fe924885c300'),
('whaleu_ratings.assert_target_edit_before','d5a420e25e59b58aa9b4273ecb385729d6aeb4ca057752028788fc2ee4b6de4a'),
('whaleu_ratings.canonical_text','e9434d9faefd05a93d435ff55d0c32fe536d2854fb5fdbb9215cfc75d465d9ca'),
('whaleu_ratings.capture_subscription_fanout','e16a9e3ec6810e8e473fc46a1860b8e8311d9b74d844b3255bcebd86dfb57c2f'),
('whaleu_ratings.catalog_seal','5453c82f1b7252b2a54b0437bd096f741b50864bdc8b7d52db9e995d57d658aa'),
('whaleu_ratings.category_ancestry_current','7628a73b683d75dd0bbade0f0118ba7c9b1f086f9a53aea4293ee47d09605f89'),
('whaleu_ratings.category_authority_snapshot','a3cbd01a02ee60a213cd39b74e96951f7b700cd6adf1ccf87bd2f0311e1e9234'),
('whaleu_ratings.category_catalog_artifact_causal','1ce07d2ca474485804b84d45128bd918668de77f4c1bd62132148fa50ff9060f'),
('whaleu_ratings.category_catalog_compat_current','0006df0ac529e101feedfd65e1e43a66056322fb3c024aa669587800b342f2f3'),
('whaleu_ratings.category_catalog_compat_until','0b97236a111dac8f951b7abd509d14aa65685b4885148874c2a6dde0a5924847'),
('whaleu_ratings.category_catalog_sources_complete','ce97b84dcf90234d3c34abfe530f83536412a4add581f558ffe6359768ce367f'),
('whaleu_ratings.category_closure_guard','1a92d0098082e64e41093feaebca295ef9b7ec65e58e91ad815f474aa23e7689'),
('whaleu_ratings.category_command_causal','33383d996e4df5e7c42a3c09a768d4e5d17ad88c4c1d81da68cea101b1c0dde0'),
('whaleu_ratings.category_command_publish','a3a39901f54ac7870a17c6497a1b79efd1bdf9984b90ecdef5176a49fa4ad5c9'),
('whaleu_ratings.category_copy_target_lineage','bdcf5f1dd5aabf5e80844e69ad50f6bdf8af1788a2d8500e1fbb5b7ba36976e0'),
('whaleu_ratings.category_effective_row_causal','ef99b362b29e05729e90d90a6971b2c236bbe84359b3798d587e42064e6fa89f'),
('whaleu_ratings.category_envelope','12979eb33ff40088f7352878681d348d08ab46d16ffc3fb3b6dc443e216ab88d'),
('whaleu_ratings.category_head_preserves_native','d634e2b8896ef29cfd012afe4bca47397ff4afd866953762ec7b115a0081ace6'),
('whaleu_ratings.category_intent_hash','e3d7643ffcc715a1507098108fcccb60b41a599d3a5e360be805d4e76c156523'),
('whaleu_ratings.category_intent_valid','13f41ef5454393ab32789b733edf68742830168f7675a0f9de62fc3106826aa4'),
('whaleu_ratings.category_materialization_guard','2575476c3b04fbb3df4325a5cc7563a7d154f16b4257dca8b1f75c7795f0ce99'),
('whaleu_ratings.category_preparation_causal','ebdbaaeba0ba1d4834abc5867cc3d5cd85e404aaa742bd11a4c25488ace1d40f'),
('whaleu_ratings.category_preparation_guard','f9dc02092e2ad57685db1618c7759af584576b59d02f063d455d1df9958d2122'),
('whaleu_ratings.category_record_opaque_catalog','19baf8fe2c672d0d97c96a71e5fb380ae813467e446c382e998546eb2e629f2c'),
('whaleu_ratings.category_record_opaque_lineage','4d49380c08f82d6667cfef37182feca4318ef08f4f8766ab89de81ce54bba7ba'),
('whaleu_ratings.category_source_artifact_causal','f58a07ba84d8481fc2618be8a5339628457ad923598aac178e4ba88ad7269a74'),
('whaleu_ratings.category_topology_regions','bd63389ec8d68409dad9eb993f07381b2c20d689c1643004ac171f94c87284b8'),
('whaleu_ratings.category_transition_guard','427f76fae9d544f147579db2fb8d1612a14187092b526aa2f53bad99980629c4'),
('whaleu_ratings.category_tree','df46c9749c9010da16b59b75615af320cf3eee4ef08e8c23a394eb0ad6366fd2'),
('whaleu_ratings.category_writer','e79f560262d942a8d763598639254e08c319ff7636b7dacacb3e57005aa24dc5'),
('whaleu_ratings.claim_command','1e73d062e3969b3de83e1f7d52db2979f19df021a7152537b85ab05ac5414847'),
('whaleu_ratings.comment_change','2807cfebdf6eea65187504a4943a0f0542ef53b405387772a088eb8f85b25c08'),
('whaleu_ratings.comment_transition_source','f63975bdb93e3db27ba34339581d885b673e9bf3e47102684e25b0054ca5a5bb'),
('whaleu_ratings.creation_canonical_json','092bc0d0c5a392e6a1697c7d966de1bcec555c216d913acff73a7bfe7ebcf180'),
('whaleu_ratings.effect_complete','9baed36543235006a5c333e6eacf3fc25d9e0e3749fa128cd8eec88f5bffb4ed'),
('whaleu_ratings.effect_guard','badd1d9a0dd9628fdf831a08dfd5934d046c85a91b86ee28497544521509fff3'),
('whaleu_ratings.enroll_native_like_subject','dbd7a91a9ec4fdb314a42437c447008d72816e1335f32ec0bc25e9463cd04e8b'),
('whaleu_ratings.expected_direct_notices','fac39834d4d670790c7368b1a122afc717aa95fdea7188274b3b68b0e7a30baa'),
('whaleu_ratings.expected_reward_units','c3b0cce6c6e91f3cc894601f1aaf7b14f4f4849c87ac217cf01afd38cadaf6cb'),
('whaleu_ratings.fresh_score_baseline','91cfb216a0ab2440601451c3a17d009580ac268af39c4b70f31f6ec4a43860a4'),
('whaleu_ratings.guard_navigation_epoch','4596e3f75d37bd780ba636d383e41d850f7d7a3a376f5c2672bf85f187b09ebf'),
('whaleu_ratings.guard_random_pool_epoch','53111133b7cf033495a9a850d83a1de5eadebd65691f0767b3fdededee734c7f'),
('whaleu_ratings.head_validate','59984328a4bbc71d2307382b0b8ddef4c6af2046e968eabf247319eabd2d187c'),
('whaleu_ratings.immutable','3a308bd77474e14e36a3f820038ce6b3fa3e55742f55a60fe206307b3329668e'),
('whaleu_ratings.initialize_like_state','dab0b474f4a101a10218b27957fa5f55c6a540f143fb4812841c8d2ec2ef0c9e'),
('whaleu_ratings.initialize_root_order','91ca7bc3dce162dcdfbb62bd715e3fe10f55b3d33222652f24e2c025f9740c0f'),
('whaleu_ratings.initialize_subscription_state','19dfdeae2218f2e06b84847a2f3ad557e976811e1426eb61260ecb31bed6aea6'),
('whaleu_ratings.initialize_summary','da304fbd180e0b985a53e530689c10e091992fadcf3669a383771d2eb415ba83'),
('whaleu_ratings.initialize_target_definition','ee36d17a363bbaf5d28179e4323479cc5f17584931f1ee8308ba248cd6dbd613'),
('whaleu_ratings.initialize_target_subscription','84ad2f2d1274b40b1f468b287056c770c062fccab738072d87cd680a81f617c3'),
('whaleu_ratings.like_effect_guard','4405ddb658bf459975521399665084587a6b3f53629c5e2ae56941bc248ea27d'),
('whaleu_ratings.like_membership_change','1ffdd799a559a3c257db5181cc93e7bcff720fed73039ad15477a3b6772b654e'),
('whaleu_ratings.like_noop_guard','7991598293f6be510c07a6daddcd193d0999f7dc192a24746d63eed7a8c88eb1'),
('whaleu_ratings.like_request_causal','cc9568b744e74935c4883963e43d8250b65dbad6911ad3894b94b27b54ad2c47'),
('whaleu_ratings.like_reward_source_guard','66ef1050d0ac8dfd0fecbe98cd6b4a7f07d93cd8819a60b1f739d4873cee0e23'),
('whaleu_ratings.like_state_guard','72b4f6212d3f88721674e09b98cd30b2e07d7157c24dd07b96eacac8b42144e5'),
('whaleu_ratings.like_subject_complete','c1f48949876ef0f4dec92307845caaff2dae817b1bd6fe3d3d76cd2ca1a97c17'),
('whaleu_ratings.like_subject_guard','315dce58d8fcb80266cb7a1824eebe9499e9e3a42c84b12ca78ca6a1714c18e8'),
('whaleu_ratings.like_transition_complete','c381d1ef199387d2ea2da58df8a86f12a8543af51ba051e15b1bbb191716efc8'),
('whaleu_ratings.like_transition_guard','247c0ce9b7a5b17090cd947b73880ba58d73c969140367ccbde6bca16cf4f61d'),
('whaleu_ratings.lock_like_subject','9489a18d435aeb0fd04b0262915bd291d825383e625d5ecc39eec6b2160cf044'),
('whaleu_ratings.lock_subscription_target','4d1393a0fa894670dbdbd69f194caacb30bca3900f45f22156acbcb584ea975f'),
('whaleu_ratings.managed_source_causal','e8347158af6c42e673783db70ac6bd50b3f1d4e26749a6a46ab75bf32c1d183d'),
('whaleu_ratings.membership_validate','5dda35b3f54b82404940069bab26106e06593f40ba580839da65b801cd70edce'),
('whaleu_ratings.native_policy_head_guard','98e39c6d130c573aa54a58b0120d0eaf15c1facacbf01c94d58bf399a348fa0b'),
('whaleu_ratings.nested_insert','fc3746cd4ca7a46163b2b678681f054452b79c0ca2c1a685ce01402febf56797'),
('whaleu_ratings.next_subscription_order','fdfb791b37f110e4cf9cb694800868813f6dd4b17688afb9d4ca5554d0f6720f'),
('whaleu_ratings.notice_obligation_guard','61af98d572f7eb81342fd81445ec0823857aa9b7ed5e0d7fdc6c7c945b8a9e1c'),
('whaleu_ratings.origin_head_guard','284fe3c2e861ada66626ba66a4d4e1475efa4654890229550131aaed8c42ffb4'),
('whaleu_ratings.origin_topology_shape','db02741c04eced5fe6e753ef96f83720c88799d126168736ecdd986f8c70afe9'),
('whaleu_ratings.owner_delete_audit_guard','b9b4066b383881261d84b97f0c7c68d4b74b2c28f4024b75573132a3876eabc4'),
('whaleu_ratings.owner_delete_id_valid','c30fa4ebf939819f45f428fc3da75537149818c5ffb24f0c72058d1bc668cb21'),
('whaleu_ratings.owner_delete_intent_hash','83630f8441493bf641eb7cfc79b6cc5de12f2d9724c9cb211f342958f7fe5961'),
('whaleu_ratings.owner_delete_intent_valid','3a7ff98c4571413ac5ee0176c15140bacfa2b37a9db302d6f71fb251fe401f67'),
('whaleu_ratings.owner_tombstone_guard','fe3ac102995509c63ef7f734345092974f61f1f52d4141487d198b310893ac35'),
('whaleu_ratings.policy_writer','eee334cc341cd2bad64da59c5660b63bc2ec8e19f5397816ae263b866418115a'),
('whaleu_ratings.preparation_definition','be2ea9750c86c9a8afd5884eb1de295d9c35a1bd5a58ed9d1e5af8ff657a4fd5'),
('whaleu_ratings.project_root_order_event','cc4c91932fe356da1d6f705e719af330d75afdf5dbd1913f4ea70ec34f7abb20'),
('whaleu_ratings.project_subscription_transition','ec674f3adc2eddbe7db133664145053db09990dd31accc37cb02b4e8fda2f78c'),
('whaleu_ratings.record_comment_transition','81ebd48e50715342a363b202d16cadf01bc27c24319af5fc3511c38d096e1dce'),
('whaleu_ratings.record_effect','92650efc7cb48eed7e783ebcb8a1fae463b1b514976ff4a4f887161ed14c31a9'),
('whaleu_ratings.record_like_effect','ee5496b2f5f6a83baa799a2ef08c12c248916557d4561fd3fa4728e7c7fdc090'),
('whaleu_ratings.record_like_transition','822e66b27d090e083a35e09baecc074f6dfaede6e5a7c982b449bc3ed0647694'),
('whaleu_ratings.record_reply_transition','1a83e48e88525df9e441e470f14bc372b5bca59e13a4de3ecd37ce3334116c21'),
('whaleu_ratings.record_root_order_event','abbe828933e0c7172e63a0e73472679c4b8d730e9f1c2046c8339dc3057ce4d9'),
('whaleu_ratings.record_subscription_effect','06115909832d3f75f3b77c029d180892a899c5d41312d3040b3576f4f57dfb69'),
('whaleu_ratings.record_subscription_transition','0ba5b13eae4f78922349ff7df99c7cacc88f95cb7918103ac474b1f58220cdae'),
('whaleu_ratings.record_target_creation','5d045a7c7f5a32d91dde36f38f5e380bf67762350d4bd203878062a1174850d0'),
('whaleu_ratings.record_target_definition_lifecycle','f63ccf3ef70ef3474deb72567f2aa1b2488a9eeaa889788be5980b047dde6c5f'),
('whaleu_ratings.record_target_state','cecf0d92d12759a85bc0652ad87efbff7c6ca53208768008e41b5c3b8c3a8bc9'),
('whaleu_ratings.reply_change','0364946ef68958a3c3a8a5f8ee58ad6d87c5083ed96c422709b4323b4de9a4a5'),
('whaleu_ratings.reply_head_guard','a24ced3885325ca5bdba26f4706cb0d77fbbf43c8c6f181c83a7878f78fe82f6'),
('whaleu_ratings.reply_transition_source','af1859e8b83ce2aa94f0c7c70d43bdc2e226a7facff77074611ac7c33d17dbe6'),
('whaleu_ratings.request_causal','bbeb317ba90049bf576dfc142fa6b83a39344f47f5cd0bb7d7ddb43c3601c151'),
('whaleu_ratings.request_immutable','8b2ea39946b534dd17c6179d95f2524f2fdd9866e1bc2395f8123345453c37a6'),
('whaleu_ratings.require_review_binding','f99cf1601aa8b4fc40f5b43afc8e0ae5bf408a71056579db3722ae0a33bbff2f'),
('whaleu_ratings.reward_group_guard','9f067af914b50823d97585e95bdfadba5cf691ed3b784238af9998bcc3cccac5'),
('whaleu_ratings.reward_unit_guard','ed2d867849d1878b5840d0b2cb1de8218eb5f142bb5dc7ac273fb7cc4a1082e3'),
('whaleu_ratings.root_order_baseline_guard','7d526db045598e320ab2c5f617b01e7f704f70dc0dcb3ab7d769310cefd6287b'),
('whaleu_ratings.root_order_event_complete','ecc32aea012e4ce1431dfdc3558382e9da3bac8d3907986684cfc79d0fa657f3'),
('whaleu_ratings.root_order_event_guard','c7f7410a6731ff2913cc1c4c4e5336d1db6ee789e72fe1f2a9dd6322978aa8a2'),
('whaleu_ratings.root_order_projection_guard','8e63328604041a3512b780e6271893bd571db09e93bf60794c15331b5384b53e'),
('whaleu_ratings.root_order_source_complete','c15e44a2b713577e3d73d0167288f6d06070056447c92be97e14ed574e2c754f'),
('whaleu_ratings.root_order_target_complete','e4bdb2c26651c2e0664b630598bf9e477d319f15e2ae4575249ebec3533b2057'),
('whaleu_ratings.root_parent_lock','778fe92f3fa16603e9c416ecc234960206594e5e6bd0f897448c020d4529b27f'),
('whaleu_ratings.score_chain_causal','97864718c9e79a35b50cba2dcb7ce2b9ff617ba46630a15d6d53b2536fad13d3'),
('whaleu_ratings.score_delta_causal','716303fbac4be2a5ed1f32eb874322394a6bea4231b88cf0ab8d0c08b46ebdf5'),
('whaleu_ratings.source_transaction_causal','096997251c8048c35d40a28e18be6199cb441329ddef8b6f00cc538896b13737'),
('whaleu_ratings.subscription_baseline_complete','47aeaa41fd52d99dd1b5df0f22635a9fc0510fac80182937a9208e8587e0ba13'),
('whaleu_ratings.subscription_baseline_guard','ffec7d84efdf0b9edd480817d06954ea0316d654981a1ec31e56b7b85812af57'),
('whaleu_ratings.subscription_effect_guard','f7e02563eb3cd049d872eb30cb43466c4c2a7ef88cfef11bc52a2f429b8cace7'),
('whaleu_ratings.subscription_epoch_guard','a2d1ba743fa2a1fc650eb55b186c8035839913b12197adcadcc75722d13019e0'),
('whaleu_ratings.subscription_fanout_complete','b8369aff0ff613596aa3259d5b6afa9642438f2bab0a1c735f5baf88c742d1e6'),
('whaleu_ratings.subscription_fanout_raw_page','b40b3a114ebec0b79f613c9e4b00c1fe14841042f5223787a2ddb732245cae47'),
('whaleu_ratings.subscription_fanout_source_guard','b41674f93e903ff4ac467d45ca6befb9639d5fc83d1f4f3e7f2cb31bfb687484'),
('whaleu_ratings.subscription_membership_change','a05439f50c7b6f505190ff5d9d841624f449453d4f5fb2eb6aae8179adf44d9f'),
('whaleu_ratings.subscription_noop_guard','bdd46176232cbed214da450f6b0be99c266944cab2ce3035dcd5917fb4bdd613'),
('whaleu_ratings.subscription_request_causal','08a5671585846fcdcd9d7ded9862e44ab43e4981c9b76e80698f75a81a62adbb'),
('whaleu_ratings.subscription_reward_source_guard','6dc211b5167a14fed3ad720dbaabbc2ac02bfd100661edc49a8e7c0a1a2a307e'),
('whaleu_ratings.subscription_state_guard','d01830cb021271db825217ea45fb81874335c85a3f7790ef84a75dc9c126fac6'),
('whaleu_ratings.subscription_stream_complete','c5ecb063e104ea342287ac6c3ae4ff6a5109d88fdbf3669d68db7992cb161a74'),
('whaleu_ratings.subscription_stream_entry_guard','e51ca527332cd9aa506d73e90538d0fb37d6babbd161ccb10cb1957a5f749ce1'),
('whaleu_ratings.subscription_stream_guard','17640c15e44f93ad92e930a11553af182bc24c59d64e4a36545d243ca1d4d5e4'),
('whaleu_ratings.subscription_target_complete','07abbe3adfa5fc1f7d229e38b0cedcd3cc7b12ad10e49f747eb0683e948ac75f'),
('whaleu_ratings.subscription_transition_complete','2cb41641ecc3e22019b4ec8917326c6c4fccb62e1b0fa3b54b6b979af9d0dc27'),
('whaleu_ratings.subscription_transition_effect_complete','0bbc67aa591dfda1c981b2b873179449d30c8babb05cdff2bade754145ba42b7'),
('whaleu_ratings.subscription_transition_guard','9b821ce96fdf9e981ddb36f05f0dde0ac2f165457be1040c5d07f02bbe33ff3a'),
('whaleu_ratings.summary_causal','c92bee8039a622c31cf4dd3a9b77e9064553e44d90d65d3ed61bd5953277be52'),
('whaleu_ratings.summary_reverse_causal','04425592e35a8fd1514ed4055a8decf67e6d43c19810e1fe956407af47449ebf'),
('whaleu_ratings.target_create_causal','456eed80748f75da2e4d3cdb086b94f3a0355e9880e64ff719228755b840563c'),
('whaleu_ratings.target_definition','bb97c55d060754958f04ac99ebbce4d1030aa5d711ce6d2f0fc8de01b640c835'),
('whaleu_ratings.target_definition_artifact_causal','d6b9cf9d0ec6f904d8d8506326102eb6984afbd81426a16302835fea2f86b21d'),
('whaleu_ratings.target_definition_head_guard','ffeea08d9be94ca8a2a25755cbe79323f488e4b3e1a292bac3799b9597f0d54b'),
('whaleu_ratings.target_definition_lifecycle_guard','558ef919093ca325fcffbc7e500e9e9fd9d344b73c468111290c2a761fb7c06b'),
('whaleu_ratings.target_definition_version_guard','12ed37b0ba5df2579d70c3c86302878b135639082438ee4d6760aa44f7590bd7'),
('whaleu_ratings.target_edit_catalog_current','6d07b2c0cd4541c23639834b4d224a1b23644d161924a1da05419f5e5781a4b0'),
('whaleu_ratings.target_edit_closure_guard','f993f4b64244529ac1fbf3f941e3a249c691461bcaf1606de9590b50a4d74e14'),
('whaleu_ratings.target_edit_command_causal','1481ddda3fa75b4da786ef120736b9d744e092ee13c0e4d2482306e5303e845e'),
('whaleu_ratings.target_edit_envelope','cab87d042cb3b73f4e9634da10a96f50da340e2caabed75680864ea67a004855'),
('whaleu_ratings.target_edit_intent_hash','4cd32ecbe3e814b5829272a6cf8eb1fe981b2e99093ec82e29f7bdda165dfc85'),
('whaleu_ratings.target_edit_intent_valid','4d64a905688f172642ec6ed5e4c2ab39526072ed57c1efd185013b174c858fae'),
('whaleu_ratings.target_edit_noop_guard','0a4146072140e99bd51ad7783ec7d1f69b6d7391b4e561e8d99e37d44b56ff3a'),
('whaleu_ratings.target_edit_preparation_causal','b1c5e2a021b1615e308be6870d153d902dca2701bfab8947f76097df7e4a8610'),
('whaleu_ratings.target_edit_preparation_guard','6e0cebd03ad417547de6e1d1b6db6b23a60834ddba8d3753a0aa54d6229642f7'),
('whaleu_ratings.target_edit_session_current','e89395a909b51f3e7fe0c2dc3d151a4e2125e52bde93541b3b7b1e32e4467307'),
('whaleu_ratings.target_edit_state_causal','a0d004e0656132a747a2280f246e8d56d63c3873473a0a4ca11f8df4270d9266'),
('whaleu_ratings.target_edit_transition_guard','0d23be29dc328f4f0eb8e0e4c300de0024be7862e63c6ca950b962e3fc2f31b6'),
('whaleu_ratings.target_edit_writer','b8c31b33510b7a841bc83cccee5db06ab261e02a7f646d3c1ae01dc51179eca3'),
('whaleu_ratings.target_owner_delete_causal','5536df89d0c71c94ba9a48f9df823ec9a056e1e86193a2f49bd9c64d9efa777a'),
('whaleu_ratings.target_owner_delete_state_causal','48c8a5a19091ee617b20d5af8e4f15c943b04af10b78a43099a2dbe09703a8c7'),
('whaleu_ratings.target_owner_delete_writer','440779bf55d0c399cf9d35c86387d7135ee2e8919aa11f7fe9532f3b3e815a0a'),
('whaleu_ratings.target_state_definition_guard','b7d0d0263fdbfcbddfdaf970f889f171294ebdcee844edcd4c23a38cfed1f837'),
('whaleu_ratings.transition_effect_complete','55d232bac320a357ba22abbb0e617d0ba28de24e7610f42c689e96a83cf98f08'),
('whaleu_ratings.verify_admin_delete_request','8423da9481a4e0ddca25f044403cebca0a2cecb986fbe65597b66b1ebc9a7875'),
('whaleu_ratings.verify_category_catalog','ea0cfe06bd8f3a1f0d1030c0754d45c9d03ad5c6e7c54d10846ec0c477f6e5dc'),
('whaleu_ratings.verify_category_release','b1ba8bdec09871795949383e3439eebc73e148725855797d881905e87349d3e6'),
('whaleu_ratings.verify_target_create','e69ef99ec6037add7c4470181571d3821596143de05ae8716da032a7fadf42d4'),
('whaleu_ratings.verify_target_definition_initial','98267837be14b4007df3d33a3040199530fff56834f06a052e6b64e625554a42'),
('whaleu_ratings.verify_target_definition_lifecycle','221056be9762f806d043251e5393f4c3f860b150e5ba5c9f6e164aebacc4b2da'),
('whaleu_ratings.verify_target_edit','f80362cc7f1bbe744c188ad2bc06bf427ce54e4f32cc75da5c2599269b9d4c47'),
('whaleu_ratings.verify_target_owner_delete','c3bb0792c79b0483026bd8d885aa302bae727d1fbcb9cc9e3fc9078cd9e74f9e')
 ) expected(name,digest) LOOP
  SELECT count(*),min(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) INTO n,actual FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname||'.'||p.proname=item.name;
  IF n<>1 OR actual IS DISTINCT FROM item.digest THEN RAISE EXCEPTION 'Unexpected M3B function baseline: %',item.name USING ERRCODE='23514';END IF;
 END LOOP;
END $fingerprint$;

CREATE FUNCTION whaleu_ratings.scoped_scope_key_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(value='global' OR value ~ '^campus:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
$$;
-- Source vectors have exactly five scalar string fields. Serialize this
-- frequent complete-vector case set-wise with precisely the existing canonical
-- key/array order; malformed or other domains retain the general serializer.
CREATE FUNCTION whaleu_ratings.scoped_digest(domain text,value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE canonical text;
BEGIN
 IF domain='vector' AND jsonb_typeof(value)='array' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value) entry WHERE CASE WHEN jsonb_typeof(entry)='object' THEN
   entry-ARRAY['digest','id','key','kind','revision']<>'{}'::jsonb
   OR NOT coalesce(jsonb_typeof(entry->'digest')='string' AND jsonb_typeof(entry->'id')='string'
    AND jsonb_typeof(entry->'key')='string' AND jsonb_typeof(entry->'kind')='string' AND jsonb_typeof(entry->'revision')='string',false)
   ELSE true END) THEN
   SELECT '['||coalesce(string_agg('{"digest":'||(entry->'digest')::text||',"id":'||(entry->'id')::text
    ||',"key":'||(entry->'key')::text||',"kind":'||(entry->'kind')::text||',"revision":'||(entry->'revision')::text||'}',',' ORDER BY ordinal),'')||']'
    INTO canonical FROM jsonb_array_elements(value) WITH ORDINALITY item(entry,ordinal);
  END IF;
 END IF;
 canonical:=coalesce(canonical,whaleu_ratings.creation_canonical_json(value));
 RETURN encode(sha256(convert_to('whaleu:rating-scoped-'||domain||':v1'||chr(10)||canonical,'UTF8')),'hex');
END $$;
CREATE FUNCTION whaleu_ratings.scoped_scope_keys_valid(value text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(cardinality(value) BETWEEN 1 AND 1001 AND value=ARRAY(SELECT DISTINCT x COLLATE "C" FROM unnest(value) x ORDER BY 1)
 AND NOT EXISTS(SELECT 1 FROM unnest(value) x WHERE NOT whaleu_ratings.scoped_scope_key_valid(x)),false)
$$;
CREATE TABLE whaleu_ratings.scoped_source_epoch(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL CHECK(version=1),epoch bigint NOT NULL CHECK(epoch>=0));
CREATE TABLE whaleu_ratings.scope_protocol_epoch(LIKE whaleu_ratings.scoped_source_epoch INCLUDING ALL);
INSERT INTO whaleu_ratings.scoped_source_epoch VALUES(true,1,0);
INSERT INTO whaleu_ratings.scope_protocol_epoch VALUES(true,1,0);
CREATE FUNCTION whaleu_ratings.scoped_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'UPDATE' OR pg_trigger_depth()<2 OR (NEW.singleton,NEW.version) IS DISTINCT FROM (OLD.singleton,OLD.version)
 OR OLD.epoch=9223372036854775807 OR NEW.epoch<>OLD.epoch+1 THEN RAISE EXCEPTION 'Scoped epoch is source-owned and retained' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER scoped_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.scoped_source_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_epoch_guard();
CREATE TRIGGER scoped_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.scope_protocol_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_epoch_guard();
CREATE TRIGGER scoped_epoch_retain BEFORE TRUNCATE ON whaleu_ratings.scoped_source_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER scoped_epoch_retain BEFORE TRUNCATE ON whaleu_ratings.scope_protocol_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE FUNCTION whaleu_ratings.scoped_public_writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;
 RETURN NULL;
END $$;
CREATE FUNCTION whaleu_ratings.advance_scoped_source_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE whaleu_ratings.scoped_source_epoch SET epoch=epoch+1 WHERE singleton AND version=1 AND epoch<9223372036854775807;
 IF NOT FOUND THEN RAISE EXCEPTION 'Scoped source epoch unavailable' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE FUNCTION whaleu_ratings.advance_scope_protocol_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE whaleu_ratings.scope_protocol_epoch SET epoch=epoch+1 WHERE singleton AND version=1 AND epoch<9223372036854775807;
 IF NOT FOUND THEN RAISE EXCEPTION 'Scope protocol epoch unavailable' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;

CREATE TABLE whaleu_ratings.scoped_source_attestations(
 id uuid PRIMARY KEY,revision uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('m3a_native_bridge','legacy_adoption','scoped_category_base','scoped_category_override','scoped_category_lifecycle','scoped_category_order','scoped_category_scope','scoped_target_placement','native_scoped_create','native_v1_compat_write','scope_absence','scope_capabilities')),
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 300),scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(scope_keys)),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 500),policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 500),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>effective_at),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(id,revision),UNIQUE(id,revision,source_kind,source_key),
 CHECK(digest=whaleu_ratings.scoped_digest('source',jsonb_build_object('id',id,'revision',revision,'kind',source_kind,'key',source_key,'scopeKeys',scope_keys,'payload',payload)))
);
CREATE INDEX scoped_source_scope_keys ON whaleu_ratings.scoped_source_attestations USING gin(scope_keys);
CREATE TABLE whaleu_ratings.scoped_source_heads(
 source_kind text NOT NULL,source_key text NOT NULL,source_id uuid NOT NULL,source_revision uuid NOT NULL,
 PRIMARY KEY(source_kind,source_key),FOREIGN KEY(source_id,source_revision,source_kind,source_key) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision,source_kind,source_key)
);
CREATE FUNCTION whaleu_ratings.scoped_source_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n whaleu_ratings.scoped_source_attestations;o whaleu_ratings.scoped_source_attestations;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scoped source head is retained' USING ERRCODE='23514';END IF;
 SELECT * INTO n FROM whaleu_ratings.scoped_source_attestations WHERE id=NEW.source_id AND revision=NEW.source_revision;
 IF NOT FOUND OR n.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Source head needs exact fresh attestation' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  SELECT * INTO o FROM whaleu_ratings.scoped_source_attestations WHERE id=OLD.source_id AND revision=OLD.source_revision;
  IF (NEW.source_kind,NEW.source_key) IS DISTINCT FROM (OLD.source_kind,OLD.source_key) OR NEW.source_id=OLD.source_id OR n.effective_at<=o.effective_at
  THEN RAISE EXCEPTION 'Scoped source head cannot rewind or change identity' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER scoped_source_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.scoped_source_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_source_head_guard();
CREATE FUNCTION whaleu_ratings.scoped_source_current(source uuid,revision uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT s.coverage='complete' AND s.provenance='accepted' AND s.effective_at<=instant AND s.valid_until>instant
 FROM whaleu_ratings.scoped_source_attestations s JOIN whaleu_ratings.scoped_source_heads h ON (h.source_id,h.source_revision,h.source_kind,h.source_key)=(s.id,s.revision,s.source_kind,s.source_key)
 WHERE s.id=scoped_source_current.source AND s.revision=scoped_source_current.revision),false)
$$;
CREATE TABLE whaleu_ratings.legacy_adoption_manifests(
 id uuid PRIMARY KEY,source_id uuid NOT NULL,source_revision uuid NOT NULL,legacy_catalog_id uuid NOT NULL REFERENCES whaleu_ratings.catalogs(id),
 legacy_digest text NOT NULL CHECK(legacy_digest ~ '^[a-f0-9]{64}$'),scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(scope_keys)),
 crosswalk jsonb NOT NULL CHECK(jsonb_typeof(crosswalk)='array'),placement jsonb NOT NULL CHECK(jsonb_typeof(placement)='object'),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),FOREIGN KEY(source_id,source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision)
);
CREATE TABLE whaleu_ratings.scoped_adoption_identities(
 id uuid PRIMARY KEY,manifest_id uuid NOT NULL REFERENCES whaleu_ratings.legacy_adoption_manifests(id),entity_kind text NOT NULL CHECK(entity_kind IN ('category','target')),
 legacy_business_id uuid NOT NULL,source_row_digest text NOT NULL CHECK(source_row_digest ~ '^[a-f0-9]{64}$'),
 UNIQUE(manifest_id,entity_kind,legacy_business_id),UNIQUE(id,manifest_id,entity_kind,legacy_business_id),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.scoped_adoption_aliases(
 manifest_id uuid NOT NULL,source_kind text NOT NULL,source_key text NOT NULL,source_revision uuid NOT NULL,legacy_business_id uuid NOT NULL,
 identity_id uuid NOT NULL,entity_kind text NOT NULL CHECK(entity_kind IN ('category','target')),source_row_digest text NOT NULL CHECK(source_row_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(manifest_id,source_kind,source_key,source_revision,legacy_business_id),
 FOREIGN KEY(identity_id,manifest_id,entity_kind,legacy_business_id) REFERENCES whaleu_ratings.scoped_adoption_identities(id,manifest_id,entity_kind,legacy_business_id),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.category_scope_placements(
 placement_revision uuid PRIMARY KEY,category_id uuid NOT NULL,base_source_id uuid NOT NULL,base_source_revision uuid NOT NULL,
 scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(scope_keys)),source_id uuid NOT NULL,source_revision uuid NOT NULL,
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),FOREIGN KEY(base_source_id,base_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 FOREIGN KEY(source_id,source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),UNIQUE(placement_revision,category_id)
);
CREATE TABLE whaleu_ratings.target_scope_placements(
 placement_revision uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(scope_keys)),
 source_id uuid NOT NULL,source_revision uuid NOT NULL,publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(source_id,source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),UNIQUE(placement_revision,target_id)
);

CREATE TABLE whaleu_ratings.scoped_releases(
 id uuid PRIMARY KEY,compiler_version text NOT NULL CHECK(compiler_version='ratings-scoped-catalog-v1'),cause_kind text NOT NULL CHECK(cause_kind IN ('source_release','create_target_scoped','legacy_bridge','protocol_activation')),
 cause jsonb NOT NULL CHECK(jsonb_typeof(cause)='object'),source_vector jsonb NOT NULL CHECK(jsonb_typeof(source_vector)='array'),source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 affected_scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(affected_scope_keys)),negative_digest text NOT NULL CHECK(negative_digest ~ '^[a-f0-9]{64}$'),
 published_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(published_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>published_at),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(source_digest=whaleu_ratings.scoped_digest('vector',source_vector))
);
CREATE TABLE whaleu_ratings.scoped_catalogs(
 id uuid PRIMARY KEY,scope_key text NOT NULL CHECK(whaleu_ratings.scoped_scope_key_valid(scope_key)),campus_id uuid REFERENCES whaleu_campus.campuses(id),region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 head_revision uuid NOT NULL,release_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_releases(id),source_vector jsonb NOT NULL CHECK(jsonb_typeof(source_vector)='array'),source_digest text NOT NULL CHECK(source_digest=whaleu_ratings.scoped_digest('vector',source_vector)),
 category_count integer NOT NULL CHECK(category_count BETWEEN 0 AND 10000),membership_count integer NOT NULL CHECK(membership_count BETWEEN 0 AND 100000),category_digest text NOT NULL CHECK(category_digest ~ '^[a-f0-9]{64}$'),membership_digest text NOT NULL CHECK(membership_digest ~ '^[a-f0-9]{64}$'),
 sealed boolean NOT NULL DEFAULT false,effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(scope_key,head_revision),UNIQUE(id,scope_key,release_id,head_revision),
 CHECK((scope_key='global' AND campus_id IS NULL AND region_id IS NULL) OR (scope_key='campus:'||campus_id::text AND campus_id IS NOT NULL AND region_id IS NOT NULL)),
 CHECK(isfinite(effective_at) AND isfinite(valid_until) AND valid_until>effective_at)
);
CREATE TABLE whaleu_ratings.scoped_catalog_heads(
 scope_key text PRIMARY KEY,catalog_id uuid NOT NULL,release_id uuid NOT NULL,head_revision uuid NOT NULL,
 FOREIGN KEY(catalog_id,scope_key,release_id,head_revision) REFERENCES whaleu_ratings.scoped_catalogs(id,scope_key,release_id,head_revision)
);
CREATE TABLE whaleu_ratings.scoped_categories(
 catalog_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_catalogs(id),category_id uuid NOT NULL,effective_revision uuid NOT NULL,effective_digest text NOT NULL CHECK(effective_digest ~ '^[a-f0-9]{64}$'),
 parent_id uuid,level integer NOT NULL CHECK(level BETWEEN 1 AND 3),kind text NOT NULL CHECK(kind ~ '^[a-z][a-z0-9_]{0,49}$'),system_key text,is_system boolean NOT NULL,
 origin_kind text NOT NULL CHECK(origin_kind IN ('global','regional','system')),name text NOT NULL,description text NOT NULL,active boolean NOT NULL,hidden boolean NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>=0),
 PRIMARY KEY(catalog_id,category_id),UNIQUE(catalog_id,ordinal),UNIQUE(catalog_id,category_id,effective_revision),
 FOREIGN KEY(catalog_id,parent_id) REFERENCES whaleu_ratings.scoped_categories(catalog_id,category_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((level=1)=(parent_id IS NULL)),CHECK(is_system=(system_key IS NOT NULL)),CHECK(whaleu_ratings.canonical_text(name,100)),CHECK(description='' OR whaleu_ratings.canonical_text(description,500))
);
CREATE TABLE whaleu_ratings.scoped_category_lineage(
 catalog_id uuid NOT NULL,category_id uuid NOT NULL,effective_revision uuid NOT NULL,identity_kind text NOT NULL CHECK(identity_kind IN ('native_bridge','adopted','scoped_source')),
 identity_id uuid NOT NULL,base_source_id uuid NOT NULL,base_source_revision uuid NOT NULL,override_source_id uuid,override_source_revision uuid,
 lifecycle_source_id uuid,lifecycle_source_revision uuid,order_source_id uuid,order_source_revision uuid,placement_revision uuid NOT NULL,
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object'),PRIMARY KEY(catalog_id,category_id),
 FOREIGN KEY(catalog_id,category_id,effective_revision) REFERENCES whaleu_ratings.scoped_categories(catalog_id,category_id,effective_revision),
 FOREIGN KEY(base_source_id,base_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 FOREIGN KEY(override_source_id,override_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 FOREIGN KEY(lifecycle_source_id,lifecycle_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 FOREIGN KEY(order_source_id,order_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 FOREIGN KEY(placement_revision,category_id) REFERENCES whaleu_ratings.category_scope_placements(placement_revision,category_id),
 CHECK((override_source_id IS NULL)=(override_source_revision IS NULL)),CHECK((lifecycle_source_id IS NULL)=(lifecycle_source_revision IS NULL)),CHECK((order_source_id IS NULL)=(order_source_revision IS NULL))
);
CREATE TABLE whaleu_ratings.scoped_target_memberships(
 catalog_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_catalogs(id),target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),category_id uuid NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>=0),placement_revision uuid NOT NULL,
 PRIMARY KEY(catalog_id,target_id),UNIQUE(catalog_id,ordinal),FOREIGN KEY(catalog_id,category_id) REFERENCES whaleu_ratings.scoped_categories(catalog_id,category_id),FOREIGN KEY(placement_revision,target_id) REFERENCES whaleu_ratings.target_scope_placements(placement_revision,target_id)
);
CREATE TABLE whaleu_ratings.scoped_release_scopes(
 release_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_releases(id),scope_key text NOT NULL CHECK(whaleu_ratings.scoped_scope_key_valid(scope_key)),before_catalog_id uuid REFERENCES whaleu_ratings.scoped_catalogs(id),before_head_revision uuid,
 after_catalog_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_catalogs(id),after_head_revision uuid NOT NULL,
 PRIMARY KEY(release_id,scope_key),UNIQUE(release_id,after_catalog_id),CHECK((before_catalog_id IS NULL)=(before_head_revision IS NULL))
);
CREATE INDEX scoped_category_parent ON whaleu_ratings.scoped_categories(catalog_id,parent_id,ordinal);
CREATE INDEX scoped_membership_category ON whaleu_ratings.scoped_target_memberships(catalog_id,category_id,ordinal);
CREATE FUNCTION whaleu_ratings.scoped_catalog_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed')
 THEN RAISE EXCEPTION 'Scoped catalog seals once without rewriting facts' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER scoped_catalog_seal BEFORE UPDATE OR DELETE ON whaleu_ratings.scoped_catalogs FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_catalog_seal();
CREATE FUNCTION whaleu_ratings.scoped_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_catalogs;s whaleu_ratings.scoped_release_scopes;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scoped catalog head is retained' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_ratings.scoped_catalogs WHERE id=NEW.catalog_id;
 SELECT * INTO s FROM whaleu_ratings.scoped_release_scopes WHERE release_id=NEW.release_id AND scope_key=NEW.scope_key;
 IF NOT coalesce(c.sealed AND c.publication_transaction=pg_current_xact_id() AND (s.after_catalog_id,s.after_head_revision)=(NEW.catalog_id,NEW.head_revision),false)
 OR (TG_OP='INSERT' AND s.before_catalog_id IS NOT NULL)
 OR (TG_OP='UPDATE' AND ((NEW.scope_key IS DISTINCT FROM OLD.scope_key) OR NEW.head_revision=OLD.head_revision OR (s.before_catalog_id,s.before_head_revision) IS DISTINCT FROM (OLD.catalog_id,OLD.head_revision)))
 THEN RAISE EXCEPTION 'Scoped head needs exact fresh release and predecessor CAS' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER scoped_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.scoped_catalog_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_head_guard();

CREATE TABLE whaleu_ratings.compat_versions(
 id uuid PRIMARY KEY,compat_key text NOT NULL,kind text NOT NULL CHECK(kind IN ('global_compat','region_compat')),region_id uuid REFERENCES whaleu_campus.operating_regions(id),state text NOT NULL CHECK(state IN ('equal','divergent','unresolved')),
 campus_ids uuid[] NOT NULL,scoped_tuples jsonb NOT NULL CHECK(jsonb_typeof(scoped_tuples)='array'),source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),equality_digest text,
 legacy_catalog_id uuid REFERENCES whaleu_ratings.catalogs(id),release_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_releases(id),previous_version_id uuid REFERENCES whaleu_ratings.compat_versions(id),
 topology_snapshot_id uuid REFERENCES whaleu_campus.community_topology_snapshots(id),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(id,compat_key),
 CHECK((kind='global_compat' AND compat_key='global_compat' AND region_id IS NULL AND campus_ids='{}'::uuid[]) OR (kind='region_compat' AND compat_key='region_compat:'||region_id::text AND region_id IS NOT NULL)),
 CHECK((state='equal')=(equality_digest IS NOT NULL AND legacy_catalog_id IS NOT NULL))
);
CREATE TABLE whaleu_ratings.compat_heads(compat_key text PRIMARY KEY,version_id uuid NOT NULL,FOREIGN KEY(version_id,compat_key) REFERENCES whaleu_ratings.compat_versions(id,compat_key));
CREATE TABLE whaleu_ratings.compat_projection_manifests(
 id uuid PRIMARY KEY,compat_version_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.compat_versions(id),release_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_releases(id),
 before_catalog_id uuid REFERENCES whaleu_ratings.catalogs(id),after_catalog_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.catalogs(id),
 projection_digest text NOT NULL CHECK(projection_digest ~ '^[a-f0-9]{64}$'),source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),native_successions jsonb NOT NULL CHECK(jsonb_typeof(native_successions)='array'),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),CHECK(before_catalog_id IS DISTINCT FROM after_catalog_id)
);
CREATE TABLE whaleu_ratings.compat_projection_lineage(
 manifest_id uuid NOT NULL REFERENCES whaleu_ratings.compat_projection_manifests(id),category_id uuid NOT NULL,effective_revision uuid NOT NULL,
 scoped_inputs jsonb NOT NULL CHECK(jsonb_typeof(scoped_inputs)='array'),body_digest text NOT NULL CHECK(body_digest ~ '^[a-f0-9]{64}$'),review_sources jsonb NOT NULL CHECK(jsonb_typeof(review_sources)='array'),
 PRIMARY KEY(manifest_id,category_id),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.scope_protocol_versions(
 id uuid PRIMARY KEY,logical_scope_key text NOT NULL,phase text NOT NULL CHECK(phase IN ('legacy_only','ready','adopted')),previous_version_id uuid REFERENCES whaleu_ratings.scope_protocol_versions(id),
 generation uuid NOT NULL,release_id uuid REFERENCES whaleu_ratings.scoped_releases(id),capability_source_id uuid,capability_source_revision uuid,manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(id,logical_scope_key),
 FOREIGN KEY(capability_source_id,capability_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 CHECK((capability_source_id IS NULL)=(capability_source_revision IS NULL)),CHECK(phase<>'adopted' OR (release_id IS NOT NULL AND capability_source_id IS NOT NULL)),
 CHECK(logical_scope_key='global' OR logical_scope_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
CREATE TABLE whaleu_ratings.scope_protocol_heads(logical_scope_key text PRIMARY KEY,version_id uuid NOT NULL,FOREIGN KEY(version_id,logical_scope_key) REFERENCES whaleu_ratings.scope_protocol_versions(id,logical_scope_key));
CREATE FUNCTION whaleu_ratings.scoped_version_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous uuid;fresh xid8;before_phase text;after_phase text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scoped version head is retained' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='compat_heads' THEN SELECT previous_version_id,publication_transaction INTO previous,fresh FROM whaleu_ratings.compat_versions WHERE id=NEW.version_id AND compat_key=NEW.compat_key;
 ELSE
  SELECT previous_version_id,publication_transaction,phase INTO previous,fresh,after_phase FROM whaleu_ratings.scope_protocol_versions WHERE id=NEW.version_id AND logical_scope_key=NEW.logical_scope_key;
  IF TG_OP='UPDATE' THEN SELECT phase INTO before_phase FROM whaleu_ratings.scope_protocol_versions WHERE id=OLD.version_id;END IF;
  IF (before_phase='adopted' AND after_phase<>'adopted') OR (before_phase='ready' AND after_phase='legacy_only') THEN RAISE EXCEPTION 'Scope protocol cannot rewind' USING ERRCODE='23514';END IF;
 END IF;
 IF fresh IS DISTINCT FROM pg_current_xact_id() OR (TG_OP='INSERT' AND previous IS NOT NULL) OR (TG_OP='UPDATE' AND (previous IS DISTINCT FROM OLD.version_id OR (to_jsonb(NEW)-'version_id') IS DISTINCT FROM (to_jsonb(OLD)-'version_id')))
 THEN RAISE EXCEPTION 'Scope version requires exact fresh predecessor' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER scoped_version_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.compat_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_version_head_guard();
CREATE TRIGGER scoped_version_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.scope_protocol_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_version_head_guard();

-- Explicit registries. Request/context records are deliberately absent.
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['scoped_source_attestations','scoped_source_heads','legacy_adoption_manifests','scoped_adoption_identities','scoped_adoption_aliases','category_scope_placements','target_scope_placements','scoped_catalogs','scoped_catalog_heads','scoped_categories','scoped_category_lineage','scoped_target_memberships','scoped_releases','scoped_release_scopes','compat_versions','compat_heads','compat_projection_manifests','compat_projection_lineage','scope_protocol_versions','scope_protocol_heads'] LOOP
  EXECUTE format('CREATE TRIGGER a00_scoped_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate()',tab);
  EXECUTE format('CREATE TRIGGER a03_scoped_pool BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch()',tab);
  EXECUTE format('CREATE TRIGGER a04_scoped_navigation BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch()',tab);
  EXECUTE format('CREATE TRIGGER scoped_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
  IF tab NOT IN ('scoped_source_heads','scoped_catalogs','scoped_catalog_heads','compat_heads','scope_protocol_heads') THEN EXECUTE format('CREATE TRIGGER scoped_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['scoped_source_attestations','scoped_source_heads','legacy_adoption_manifests','scoped_adoption_identities','scoped_adoption_aliases','category_scope_placements','target_scope_placements','scope_protocol_versions','scope_protocol_heads'] LOOP
  EXECUTE format('CREATE TRIGGER a01_scoped_source_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_scoped_source_epoch()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['scope_protocol_versions','scope_protocol_heads'] LOOP
  EXECUTE format('CREATE TRIGGER a02_scope_protocol_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_scope_protocol_epoch()',tab);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_base_category(source uuid,revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;c whaleu_ratings.categories;l whaleu_ratings.catalog_category_lineage;b whaleu_ratings.category_base_versions;e jsonb;ad whaleu_ratings.scoped_adoption_identities;m whaleu_ratings.legacy_adoption_manifests;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=source AND scoped_source_attestations.revision=scoped_base_category.revision;
 IF s.source_kind='m3a_native_bridge' AND s.issuer='ratings-legacy-bridge' THEN RETURN whaleu_ratings.legacy_bridge_native_category(source,revision);
 ELSIF s.source_kind='m3a_native_bridge' THEN
  SELECT * INTO c FROM whaleu_ratings.categories WHERE catalog_id=(s.payload->>'legacyCatalogId')::uuid AND id=(s.payload->>'categoryId')::uuid;
  SELECT * INTO l FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=c.catalog_id AND category_id=c.id;
  SELECT * INTO b FROM whaleu_ratings.category_base_versions WHERE category_id=c.id AND category_base_versions.revision=l.base_revision;
  IF NOT coalesce(c.revision::text=s.payload->>'categoryRevision' AND l.source_kind='native' AND l.base_revision=c.revision AND l.effective_revision=c.revision
   AND EXISTS(SELECT 1 FROM whaleu_ratings.category_base_heads WHERE category_id=c.id AND category_base_heads.revision=l.base_revision)
   AND whaleu_ratings.category_catalog_sources_complete(c.catalog_id) AND whaleu_community.rating_category_base_current(c.id,l.base_revision,b.envelope),false)
  THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('id',c.id,'parentId',c.parent_id,'level',c.level,'kind',c.kind,'systemKey',c.system_key,'isSystem',c.system_key IS NOT NULL,'originKind',c.origin_kind,'name',c.name,'description',c.description,'active',c.active,'hidden',c.hidden,'ordinal',c.ordinal::text,'identityKind','native_bridge','identityId',c.id);
 ELSIF s.source_kind='legacy_adoption' THEN
  RETURN whaleu_ratings.scoped_adoption_category(source,revision);
 ELSIF s.source_kind='scoped_category_base' THEN
  e:=s.payload->'reviewEnvelope';
  IF NOT coalesce(e->>'purpose'='publish_rating_category_base_scoped' AND e->>'sourceId'=s.id::text AND e->>'sourceRevision'=s.revision::text
   AND whaleu_community.rating_scoped_category_source_current(s.id,s.revision,e),false) THEN RETURN NULL;END IF;
  IF NOT coalesce(jsonb_typeof(s.payload->'active')='boolean' AND jsonb_typeof(s.payload->'hidden')='boolean' AND s.payload->>'ordinal' ~ '^(0|[1-9][0-9]{0,18})$'
   AND s.payload->>'originKind' IN ('global','regional'),false) THEN RETURN NULL;END IF;
  RETURN (e->'body')||jsonb_build_object('id',e->'categoryId','isSystem',e->'body'->'systemKey'<>'null'::jsonb,'originKind',s.payload->'originKind','active',s.payload->'active','hidden',s.payload->'hidden','ordinal',s.payload->>'ordinal','identityKind',CASE WHEN s.source_kind='legacy_adoption' THEN 'adopted' ELSE 'scoped_source' END,'identityId',e->'identityId');
 END IF;RETURN NULL;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_expected_category(placement uuid,scope text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p whaleu_ratings.category_scope_placements;base jsonb;over whaleu_ratings.scoped_source_attestations;life whaleu_ratings.scoped_source_attestations;ordering whaleu_ratings.scoped_source_attestations;over_count integer;life_count integer;order_count integer;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.category_scope_placements WHERE placement_revision=placement;
 IF p.placement_revision IS NULL OR NOT scope=ANY(p.scope_keys) OR NOT whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())
 OR NOT whaleu_ratings.scoped_source_current(p.base_source_id,p.base_source_revision,clock_timestamp()) THEN RETURN NULL;END IF;
 base:=whaleu_ratings.scoped_base_category(p.base_source_id,p.base_source_revision);
 IF base IS NULL OR base->>'id'<>p.category_id::text THEN RETURN NULL;END IF;
 SELECT count(*) INTO over_count FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_override' AND scope=ANY(s.scope_keys) AND s.payload->'reviewEnvelope'->>'categoryId'=p.category_id::text;
 SELECT count(*) INTO life_count FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_lifecycle' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
 SELECT count(*) INTO order_count FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_order' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
 IF over_count>1 OR life_count>1 OR order_count>1 THEN RETURN NULL;END IF;
 IF over_count=1 THEN
  SELECT s.* INTO over FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind='scoped_category_override' AND scope=ANY(s.scope_keys) AND s.payload->'reviewEnvelope'->>'categoryId'=p.category_id::text;
  IF NOT coalesce(whaleu_ratings.scoped_source_current(over.id,over.revision,clock_timestamp()) AND scope='campus:'||(over.payload->'reviewEnvelope'->'scope'->>'campusId')
   AND over.payload->'reviewEnvelope'->>'identityId'=base->>'identityId'
   AND over.payload->'reviewEnvelope'->>'baseSourceId'=p.base_source_id::text AND over.payload->'reviewEnvelope'->>'baseSourceRevision'=p.base_source_revision::text
   AND whaleu_community.rating_scoped_category_source_current(over.id,over.revision,over.payload->'reviewEnvelope'),false) THEN RETURN NULL;END IF;
  base:=base||(over.payload->'reviewEnvelope'->'body');
 END IF;
 IF life_count=1 THEN
  SELECT s.* INTO life FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind='scoped_category_lifecycle' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
  IF NOT coalesce(whaleu_ratings.scoped_source_current(life.id,life.revision,clock_timestamp()) AND jsonb_typeof(life.payload->'active')='boolean' AND jsonb_typeof(life.payload->'hidden')='boolean'
   AND life.payload->>'baseSourceId'=p.base_source_id::text AND life.payload->>'baseSourceRevision'=p.base_source_revision::text,false) THEN RETURN NULL;END IF;
  base:=base||jsonb_build_object('active',life.payload->'active','hidden',life.payload->'hidden');
 END IF;
 IF order_count=1 THEN
  SELECT s.* INTO ordering FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind='scoped_category_order' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
  IF NOT coalesce(whaleu_ratings.scoped_source_current(ordering.id,ordering.revision,clock_timestamp()) AND ordering.payload->>'ordinal' ~ '^(0|[1-9][0-9]{0,18})$'
   AND ordering.payload->>'baseSourceId'=p.base_source_id::text AND ordering.payload->>'baseSourceRevision'=p.base_source_revision::text,false) THEN RETURN NULL;END IF;
  base:=base||jsonb_build_object('ordinal',ordering.payload->>'ordinal');
 END IF;
 RETURN jsonb_build_object('body',base,'baseSourceId',p.base_source_id,'baseSourceRevision',p.base_source_revision,'overrideSourceId',over.id,'overrideSourceRevision',over.revision,
  'lifecycleSourceId',life.id,'lifecycleSourceRevision',life.revision,'orderSourceId',ordering.id,'orderSourceRevision',ordering.revision,'placementRevision',p.placement_revision);
END $$;
CREATE FUNCTION whaleu_ratings.scoped_current_source_vector(scopes text[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'revision',s.revision,'kind',s.source_kind,'key',s.source_key,'digest',s.digest) ORDER BY s.source_kind COLLATE "C",s.source_key COLLATE "C"),'[]'::jsonb)
 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.scope_keys&&scopes
$$;
CREATE FUNCTION whaleu_ratings.scoped_catalog_current(catalog uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.sealed AND c.effective_at<=instant AND c.valid_until>instant
 AND c.source_vector=whaleu_ratings.scoped_current_source_vector(ARRAY[c.scope_key])
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_vector) s WHERE NOT whaleu_ratings.scoped_source_current((s->>'id')::uuid,(s->>'revision')::uuid,instant))
 FROM whaleu_ratings.scoped_catalogs c JOIN whaleu_ratings.scoped_catalog_heads h ON (h.catalog_id,h.scope_key,h.head_revision)=(c.id,c.scope_key,c.head_revision)
 JOIN whaleu_ratings.scoped_releases r ON r.id=c.release_id WHERE c.id=catalog),false)
$$;
CREATE FUNCTION whaleu_ratings.scoped_category_current(catalog uuid,category uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_ratings.scoped_catalogs;r record;expected jsonb;found_root boolean:=false;n integer:=0;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_catalogs WHERE id=catalog;
 FOR r IN WITH RECURSIVE path AS(SELECT a.*,1 depth FROM whaleu_ratings.scoped_categories a WHERE a.catalog_id=catalog AND a.category_id=category
  UNION ALL SELECT a.*,p.depth+1 FROM whaleu_ratings.scoped_categories a JOIN path p ON a.catalog_id=p.catalog_id AND a.category_id=p.parent_id WHERE p.depth<3)
  SELECT p.*,l.placement_revision,l.proof FROM path p LEFT JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id)=(p.catalog_id,p.category_id) ORDER BY p.level LOOP
  n:=n+1;IF r.level=1 AND r.parent_id IS NULL THEN found_root:=true;END IF;
  expected:=whaleu_ratings.scoped_expected_category(r.placement_revision,c.scope_key);
  IF NOT r.active OR r.hidden OR expected IS NULL OR expected IS DISTINCT FROM r.proof OR r.level<>n THEN RETURN false;END IF;
 END LOOP;RETURN found_root AND n>0;
END $$;

CREATE INDEX scoped_source_review_category ON whaleu_ratings.scoped_source_attestations(source_kind,((payload->'reviewEnvelope'->>'categoryId')));
CREATE INDEX scoped_source_metadata_category ON whaleu_ratings.scoped_source_attestations(source_kind,((payload->>'categoryId')));
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_catalog(catalog uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_catalogs;r whaleu_ratings.scoped_releases;coverage whaleu_ratings.scoped_source_attestations;expected_ids jsonb;actual_ids jsonb;row_count integer;digest text;item record;expected jsonb;body jsonb;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_catalogs WHERE id=catalog;SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=c.release_id;
 IF NOT coalesce(c.sealed AND c.publication_transaction=pg_current_xact_id() AND r.publication_transaction=pg_current_xact_id()
  AND c.scope_key=ANY(r.affected_scope_keys) AND c.source_vector=whaleu_ratings.scoped_current_source_vector(ARRAY[c.scope_key])
  AND (c.scope_key='global' OR EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments assignment WHERE assignment.campus_id=c.campus_id AND assignment.operating_region_id=c.region_id))
  AND c.source_digest=whaleu_ratings.scoped_digest('vector',c.source_vector) AND c.effective_at<=clock_timestamp() AND c.valid_until>clock_timestamp(),false)
 THEN RAISE EXCEPTION 'Scoped catalog needs current complete fresh release' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_vector) s WHERE NOT whaleu_ratings.scoped_source_current((s->>'id')::uuid,(s->>'revision')::uuid,clock_timestamp()))
 THEN RAISE EXCEPTION 'Scoped catalog includes unknown source' USING ERRCODE='23514';END IF;
 SELECT s.* INTO coverage FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE h.source_kind='scope_absence' AND h.source_key=c.scope_key AND s.scope_keys=ARRAY[c.scope_key];
 IF NOT coalesce(whaleu_ratings.scoped_source_current(coverage.id,coverage.revision,clock_timestamp()) AND coverage.payload->'complete'='true'::jsonb
  AND jsonb_typeof(coverage.payload->'categoryIds')='array' AND jsonb_typeof(coverage.payload->'targetIds')='array' AND jsonb_typeof(coverage.payload->'legacyCatalogIds')='array',false)
 THEN RAISE EXCEPTION 'Unknown source domain is never an empty catalog' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(category_id ORDER BY category_id),'[]'::jsonb) INTO expected_ids FROM whaleu_ratings.category_scope_placements p
 WHERE c.scope_key=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp());
 SELECT coalesce(jsonb_agg(category_id ORDER BY category_id),'[]'::jsonb),count(*) INTO actual_ids,row_count FROM whaleu_ratings.scoped_categories WHERE catalog_id=catalog;
 IF actual_ids IS DISTINCT FROM expected_ids OR actual_ids IS DISTINCT FROM coverage.payload->'categoryIds' OR row_count<>c.category_count
 THEN RAISE EXCEPTION 'Scoped category domain is incomplete or ambiguous' USING ERRCODE='23514';END IF;
 FOR item IN SELECT a.*,l.identity_kind,l.identity_id,l.base_source_id,l.base_source_revision,l.override_source_id,l.override_source_revision,l.lifecycle_source_id,l.lifecycle_source_revision,l.order_source_id,l.order_source_revision,l.placement_revision,l.proof
 FROM whaleu_ratings.scoped_categories a LEFT JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(a.catalog_id,a.category_id,a.effective_revision) WHERE a.catalog_id=catalog LOOP
  expected:=whaleu_ratings.scoped_expected_category(item.placement_revision,c.scope_key);body:=expected->'body';
  IF expected IS NULL OR item.proof IS DISTINCT FROM expected OR item.effective_digest<>whaleu_ratings.scoped_digest('effective',expected)
   OR jsonb_build_object('id',item.category_id,'parentId',item.parent_id,'level',item.level,'kind',item.kind,'systemKey',item.system_key,'isSystem',item.is_system,'originKind',item.origin_kind,'name',item.name,'description',item.description,'active',item.active,'hidden',item.hidden,'ordinal',item.ordinal::text,'identityKind',item.identity_kind,'identityId',item.identity_id) IS DISTINCT FROM body
   OR jsonb_build_array(item.base_source_id,item.base_source_revision,item.override_source_id,item.override_source_revision,item.lifecycle_source_id,item.lifecycle_source_revision,item.order_source_id,item.order_source_revision)
    IS DISTINCT FROM jsonb_build_array(expected->'baseSourceId',expected->'baseSourceRevision',expected->'overrideSourceId',expected->'overrideSourceRevision',expected->'lifecycleSourceId',expected->'lifecycleSourceRevision',expected->'orderSourceId',expected->'orderSourceRevision')
   OR (item.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories parent WHERE parent.catalog_id=catalog AND parent.category_id=item.parent_id AND parent.level+1=item.level AND parent.kind=item.kind))
  THEN RAISE EXCEPTION 'Scoped effective row lacks exact composed lineage' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT whaleu_ratings.scoped_digest('categories',coalesce(jsonb_agg(jsonb_build_object('revision',a.effective_revision,'digest',a.effective_digest,'expected',l.proof) ORDER BY a.ordinal),'[]'::jsonb)) INTO digest
 FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id)=(a.catalog_id,a.category_id) WHERE a.catalog_id=catalog;
 IF digest<>c.category_digest THEN RAISE EXCEPTION 'Scoped category digest mismatch' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(target_id ORDER BY target_id),'[]'::jsonb) INTO expected_ids FROM whaleu_ratings.target_scope_placements p WHERE c.scope_key=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp());
 SELECT coalesce(jsonb_agg(target_id ORDER BY target_id),'[]'::jsonb),count(*) INTO actual_ids,row_count FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=catalog;
 IF actual_ids IS DISTINCT FROM expected_ids OR actual_ids IS DISTINCT FROM coverage.payload->'targetIds' OR row_count<>c.membership_count
 THEN RAISE EXCEPTION 'Scoped target placement set incomplete or ambiguous' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.targets t ON t.id=m.target_id
  JOIN whaleu_ratings.target_scope_placements p ON (p.placement_revision,p.target_id)=(m.placement_revision,m.target_id)
  WHERE m.catalog_id=catalog AND (m.category_id<>t.category_id OR NOT c.scope_key=ANY(p.scope_keys) OR NOT whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())))
 THEN RAISE EXCEPTION 'Scoped target membership is not exact placement' USING ERRCODE='23514';END IF;
 SELECT whaleu_ratings.scoped_digest('memberships',coalesce(jsonb_agg(jsonb_build_object('targetId',target_id,'categoryId',category_id,'placementRevision',placement_revision,'ordinal',ordinal::text) ORDER BY ordinal),'[]'::jsonb)) INTO digest FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=catalog;
 IF digest<>c.membership_digest THEN RAISE EXCEPTION 'Scoped membership digest mismatch' USING ERRCODE='23514';END IF;
 IF NOT whaleu_ratings.scoped_membership_order_valid(catalog) THEN RAISE EXCEPTION 'Scoped membership order must retain before ordinals and append canonical new IDs' USING ERRCODE='23514';END IF;
 -- Any native bridge from a mixed legacy catalog carries the full legacy set.
 -- A known native subset cannot erase unknown opaque categories or targets.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_vector) v JOIN whaleu_ratings.scoped_source_attestations s ON s.id=(v->>'id')::uuid
  WHERE s.source_kind='m3a_native_bridge' AND s.issuer<>'ratings-legacy-bridge' AND NOT coverage.payload->'legacyCatalogIds' @> jsonb_build_array(s.payload->'legacyCatalogId'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coverage.payload->'legacyCatalogIds') legacy(id) JOIN whaleu_ratings.categories old ON old.catalog_id=legacy.id::uuid
  WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_scope_placements p JOIN whaleu_ratings.scoped_source_attestations src ON (src.id,src.revision)=(p.base_source_id,p.base_source_revision)
   WHERE p.category_id=old.id AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()) AND whaleu_ratings.scoped_source_current(src.id,src.revision,clock_timestamp())
    AND ((src.source_kind='m3a_native_bridge' AND src.payload->>'legacyCatalogId'=legacy.id AND src.payload->>'categoryRevision'=old.revision::text)
     OR (src.source_kind='legacy_adoption' AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_adoption_identities ai JOIN whaleu_ratings.legacy_adoption_manifests am ON am.id=ai.manifest_id WHERE ai.id=(src.payload->>'identityId')::uuid AND am.legacy_catalog_id=old.catalog_id AND ai.legacy_business_id=old.id)))))
 THEN RAISE EXCEPTION 'Mixed legacy category source set is unresolved' USING ERRCODE='23514';END IF;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_release(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;keys text[];item record;nodes bigint;members bigint;bytes bigint;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 SELECT array_agg(scope_key ORDER BY scope_key COLLATE "C") INTO keys FROM whaleu_ratings.scoped_release_scopes WHERE release_id=release;
 IF NOT coalesce(r.publication_transaction=pg_current_xact_id() AND r.published_at<=clock_timestamp() AND r.valid_until>clock_timestamp() AND keys=r.affected_scope_keys
  AND r.source_vector=whaleu_ratings.scoped_current_source_vector(r.affected_scope_keys)
  AND r.negative_digest=whaleu_ratings.scoped_digest('negative',jsonb_build_object('inventory',r.cause->'inventoryFingerprint','sources',r.source_vector)),false)
 THEN RAISE EXCEPTION 'Release affected set or exact source vector incomplete' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(category_count),0),coalesce(sum(membership_count),0) INTO nodes,members FROM whaleu_ratings.scoped_catalogs WHERE release_id=release;
 SELECT coalesce(sum(octet_length(whaleu_ratings.creation_canonical_json(to_jsonb(x)))),0) INTO bytes FROM (
  SELECT to_jsonb(a) value FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
  UNION ALL SELECT to_jsonb(a) FROM whaleu_ratings.scoped_category_lineage a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
  UNION ALL SELECT to_jsonb(a) FROM whaleu_ratings.scoped_target_memberships a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
  UNION ALL SELECT to_jsonb(s) FROM whaleu_ratings.scoped_source_attestations s JOIN jsonb_array_elements(r.source_vector) v ON s.id=(v->>'id')::uuid
 ) x;
 IF nodes>100000 OR members>100000 OR bytes>67108864 THEN RAISE EXCEPTION 'Scoped whole-release admission exceeded' USING ERRCODE='23514';END IF;
 FOR item IN SELECT s.*,h.catalog_id current_catalog,h.head_revision current_head,c.release_id catalog_release FROM whaleu_ratings.scoped_release_scopes s
  LEFT JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=s.scope_key LEFT JOIN whaleu_ratings.scoped_catalogs c ON c.id=s.after_catalog_id WHERE s.release_id=release LOOP
  IF (item.current_catalog,item.current_head,item.catalog_release) IS DISTINCT FROM (item.after_catalog_id,item.after_head_revision,release)
  THEN RAISE EXCEPTION 'Scoped release lacks its atomic current head' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.verify_scoped_catalog(item.after_catalog_id);
 END LOOP;
 -- Each cause-specific verifier is installed by 0064/0065; no labels authorize.
 IF r.cause_kind='legacy_bridge' THEN PERFORM whaleu_ratings.verify_legacy_scoped_bridge((r.cause->>'accountId')::uuid,(r.cause->>'requestId')::uuid);
 ELSIF r.cause_kind='create_target_scoped' THEN PERFORM whaleu_ratings.verify_scoped_command((r.cause->>'accountId')::uuid,(r.cause->>'requestId')::uuid);
 ELSIF r.cause_kind='protocol_activation' THEN PERFORM whaleu_ratings.verify_scope_activation(release);
 ELSIF NOT coalesce(r.cause_kind='source_release' AND r.cause->>'sourceDigest'=r.source_digest AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=(r.cause->>'issuanceSourceId')::uuid AND s.revision=(r.cause->>'issuanceSourceRevision')::uuid AND r.affected_scope_keys<@s.scope_keys AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())),false) THEN RAISE EXCEPTION 'Unknown scoped release cause' USING ERRCODE='23514';END IF;
 -- Installed by 0065. Whole-set compatibility publication is a release
 -- obligation, including ordinary source releases in already adopted domains.
 PERFORM whaleu_ratings.verify_scoped_release_compat(release);
END $$;
CREATE FUNCTION whaleu_ratings.scoped_row_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_catalogs;BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_catalogs WHERE id=NEW.catalog_id;
 IF c.id IS NULL OR c.sealed OR c.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Scoped projection cannot append to sealed or historical catalog' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER scoped_row_catalog_guard BEFORE INSERT ON whaleu_ratings.scoped_categories FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_row_catalog_guard();
CREATE TRIGGER scoped_row_catalog_guard BEFORE INSERT ON whaleu_ratings.scoped_category_lineage FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_row_catalog_guard();
CREATE TRIGGER scoped_row_catalog_guard BEFORE INSERT ON whaleu_ratings.scoped_target_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_row_catalog_guard();
CREATE FUNCTION whaleu_ratings.scoped_catalog_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release uuid;catalog uuid;scope text;BEGIN
 IF TG_TABLE_NAME='scoped_releases' THEN
  PERFORM whaleu_ratings.verify_scoped_release(NEW.id);RETURN NULL;
 ELSIF TG_TABLE_NAME='scoped_release_scopes' THEN release:=NEW.release_id;catalog:=NEW.after_catalog_id;scope:=NEW.scope_key;
 ELSIF TG_TABLE_NAME='scoped_catalog_heads' THEN release:=NEW.release_id;catalog:=NEW.catalog_id;scope:=NEW.scope_key;
 ELSIF TG_TABLE_NAME='scoped_catalogs' THEN release:=NEW.release_id;catalog:=NEW.id;scope:=NEW.scope_key;
 ELSE
  SELECT id INTO catalog FROM whaleu_ratings.scoped_catalogs WHERE id=NEW.catalog_id AND sealed AND publication_transaction=pg_current_xact_id();
  IF catalog IS NULL THEN RAISE EXCEPTION 'Scoped row lacks fresh sealed parent' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 -- Whole-release verification belongs to the immutable release boundary.
 -- Every other artifact must be the exact listed fresh sealed output. A
 -- previously flushed release cannot gain scopes (complete set plus PK), rows
 -- (sealed insert guard), alternate catalogs or a different current head.
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases parent
  JOIN whaleu_ratings.scoped_release_scopes own ON own.release_id=parent.id AND own.scope_key=scope
  JOIN whaleu_ratings.scoped_catalogs output ON output.id=own.after_catalog_id
  JOIN whaleu_ratings.scoped_catalog_heads head ON head.scope_key=own.scope_key
  WHERE parent.id=release AND parent.publication_transaction=pg_current_xact_id() AND scope=ANY(parent.affected_scope_keys)
  AND output.id=catalog AND output.sealed AND output.publication_transaction=parent.publication_transaction
  AND (output.release_id,output.scope_key,output.head_revision)=(parent.id,own.scope_key,own.after_head_revision)
  AND (head.release_id,head.catalog_id,head.head_revision)=(parent.id,output.id,output.head_revision))
 THEN RAISE EXCEPTION 'Scoped artifact lacks exact fresh current release output' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['scoped_releases','scoped_release_scopes','scoped_catalogs','scoped_catalog_heads','scoped_categories','scoped_category_lineage','scoped_target_memberships'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER scoped_catalog_causal AFTER INSERT OR UPDATE ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_catalog_artifact_causal()',tab);
 END LOOP;
END $$;
-- Exact Campus inventory/identity ABA owner registry, including zero-row writers.
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['institutions','campuses','campus_region_assignments','community_topology_heads','community_topology_snapshots','community_identity_heads','community_identity_selections'] LOOP
  EXECUTE format('CREATE TRIGGER a000_scoped_campus_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_campus.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate()',tab);
  EXECUTE format('CREATE TRIGGER a001_scoped_campus_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_campus.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.advance_discovery_count_epoch()',tab);
 END LOOP;
END $$;
