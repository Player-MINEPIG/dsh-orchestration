/** Generic examples; no game/account credentials, hardcoded devices, or production dispatch. */
export const templates = [
  {
    templateId:'daily-review',version:1,name:'Daily review',description:'Review selected task evidence for a configured time window',
    inputSchema:{type:'object',properties:{windowStart:{type:'string'},windowEnd:{type:'string'},taskIds:{type:'array',items:{type:'string'}}},required:['windowStart','windowEnd','taskIds'],additionalProperties:false},
    defaults:{source:'task-history',includePartial:true,includeRevisions:true},
    resultContract:{type:'object',properties:{outcome:{enum:['success','partial','failure','blocked','unknown']},summary:{type:'string'},report:{type:'object',properties:{title:{type:'string'},body:{type:'string'}},required:['title','body']}},required:['outcome','summary','report']},
  },
  {
    templateId:'game-daily',version:1,name:'Game daily',description:'Summarize explicitly configured game-status evidence without granting login or action permissions',
    inputSchema:{type:'object',properties:{game:{type:'string'},date:{type:'string'},evidence:{type:'array',items:{type:'object'}}},required:['game','date','evidence'],additionalProperties:false},
    defaults:{missingEvidence:'unknown',actions:'report-only'},resultContract:{type:'object',properties:{outcome:{enum:['success','partial','failure','blocked','unknown']},summary:{type:'string'}},required:['outcome','summary']},
  },
  {
    templateId:'custom-equipment-check',version:1,name:'Custom equipment check',description:'A third task type using the same configuration contract',
    inputSchema:{type:'object',properties:{equipmentIds:{type:'array',items:{type:'string'}}},required:['equipmentIds'],additionalProperties:false},
    defaults:{collector:'operator-registered-read-only-source'},resultContract:{type:'object',properties:{outcome:{enum:['success','partial','failure','blocked','unknown']},summary:{type:'string'}},required:['outcome','summary']},
  },
];
